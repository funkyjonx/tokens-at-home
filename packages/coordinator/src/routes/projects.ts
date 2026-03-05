import { Hono } from 'hono';
import { and, asc, desc, eq, or, sql } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import {
  RegisterProjectSchema,
  RegisterIssueSchema,
  COMPLEXITY_TOKEN_ESTIMATES,
  mapGitHubLabelsToComplexity,
  type IssueComplexity,
} from '@tah/shared';
import type { Db } from '../db/index.js';
import { contributors, issues, projects, tasks } from '../db/schema.js';
import { getContributorFromToken, extractBearerToken } from '../services/auth.js';

async function fetchGitHubIssueData(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<{ complexity: IssueComplexity | null; body: string | null; title: string | null }> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
      { headers: { 'User-Agent': 'tokens-at-home', Accept: 'application/vnd.github.v3+json' } },
    );
    if (!res.ok) return { complexity: null, body: null, title: null };
    const data = await res.json() as {
      title?: string;
      body?: string | null;
      labels?: Array<{ name: string }>;
    };
    return {
      complexity: mapGitHubLabelsToComplexity((data.labels ?? []).map((l) => l.name)),
      body: data.body ?? null,
      title: data.title ?? null,
    };
  } catch {
    return { complexity: null, body: null, title: null };
  }
}

export function projectRoutes(db: Db) {
  const app = new Hono();

  // List all projects (paginated, with optional search/filter)
  app.get('/', async (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10) || 100, 500);
    const offset = Math.max(parseInt(c.req.query('offset') ?? '0', 10) || 0, 0);
    const q = c.req.query('q');
    const language = c.req.query('language');
    const sort = c.req.query('sort') ?? 'recent';

    const conditions = [];
    if (q) {
      const pattern = `%${q}%`;
      conditions.push(or(
        sql`${projects.githubOwner} LIKE ${pattern}`,
        sql`${projects.githubRepo} LIKE ${pattern}`,
      ));
    }
    if (language) {
      conditions.push(sql`${projects.languages} LIKE ${`%"${language}"%`}`);
    }

    const orderBy = sort === 'name' ? asc(projects.githubRepo) : desc(projects.createdAt);
    const where = conditions.length > 0 ? and(...conditions as [ReturnType<typeof or>, ...ReturnType<typeof or>[]]) : undefined;

    const all = where
      ? await db.select().from(projects).where(where).orderBy(orderBy).limit(limit).offset(offset).all()
      : await db.select().from(projects).orderBy(orderBy).limit(limit).offset(offset).all();
    return c.json(all.map(deserializeProject));
  });

  // Get a single project
  app.get('/:id', async (c) => {
    const project = await db.select().from(projects).where(eq(projects.id, c.req.param('id'))).get();
    if (!project) return c.json({ error: 'Not found' }, 404);
    return c.json(deserializeProject(project));
  });

  // Register a project (requires auth)
  app.post('/', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);

    const contributor = await getContributorFromToken(db, token);
    if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

    const body = await c.req.json();
    const parsed = RegisterProjectSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const input = parsed.data;
    const id = randomBytes(8).toString('hex');

    await db.insert(projects).values({
      id,
      githubOwner: input.githubOwner,
      githubRepo: input.githubRepo,
      registeredBy: contributor.githubUsername,
      languages: JSON.stringify(input.languages),
      issueLabel: input.issueLabel,
      claudeMd: input.claudeMd ?? null,
      taskTypes: JSON.stringify(input.taskTypes),
      maxConcurrent: input.maxConcurrent,
      trustThreshold: input.trustThreshold,
    });

    const project = await db.select().from(projects).where(eq(projects.id, id)).get();
    return c.json(deserializeProject(project!), 201);
  });

  // Register an issue for a project
  app.post('/:id/issues', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const contributor = await getContributorFromToken(db, token);
    if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

    const project = await db.select().from(projects).where(eq(projects.id, c.req.param('id'))).get();
    if (!project) return c.json({ error: 'Project not found' }, 404);

    const body = await c.req.json();
    const parsed = RegisterIssueSchema.safeParse({ ...body, projectId: project.id });
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const input = parsed.data;

    // Dedup: return 409 if this issue is already registered for this project
    const existing = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.projectId, project.id), eq(issues.githubNumber, input.githubNumber)))
      .get();
    if (existing) return c.json({ error: 'Issue already registered' }, 409);

    const needsGitHub = !input.estimatedComplexity || !input.body || !input.title;
    const gh = needsGitHub
      ? await fetchGitHubIssueData(project.githubOwner, project.githubRepo, input.githubNumber)
      : { complexity: null, body: null, title: null };

    const title = input.title ?? gh.title;
    if (!title) return c.json({ error: 'Could not determine issue title — pass --title or check the issue exists on GitHub' }, 400);

    const complexity = input.estimatedComplexity ?? gh.complexity ?? 'small';
    const issueBody = input.body || gh.body || '';

    const BODY_WARN_CHARS = 8000;
    const bodyWarning = issueBody.length > BODY_WARN_CHARS
      ? `Issue body is ${issueBody.length} chars (>${BODY_WARN_CHARS}). Oversized bodies risk prompt injection — consider trimming before registering.`
      : null;

    const id = randomBytes(8).toString('hex');

    await db.insert(issues).values({
      id,
      projectId: project.id,
      githubNumber: input.githubNumber,
      title,
      body: issueBody,
      taskType: input.taskType,
      estimatedComplexity: complexity,
      estimatedTokens: COMPLEXITY_TOKEN_ESTIMATES[complexity],
      status: 'available',
    });

    const issue = await db.select().from(issues).where(eq(issues.id, id)).get();
    return c.json(bodyWarning ? { ...issue, warning: bodyWarning } : issue, 201);
  });

  // Project stats
  app.get('/:id/stats', async (c) => {
    const projectId = c.req.param('id');
    const project = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get();
    if (!project) return c.json({ error: 'Not found' }, 404);

    const projectTasks = await db
      .select({
        contributorId: tasks.contributorId,
        status: tasks.status,
        tokensUsed: tasks.tokensUsed,
        createdAt: tasks.createdAt,
      })
      .from(tasks)
      .innerJoin(issues, eq(tasks.issueId, issues.id))
      .where(eq(issues.projectId, projectId))
      .all();

    const totalTasksCompleted = projectTasks.filter((t) => t.status === 'completed').length;
    const totalTokensConsumed = projectTasks
      .filter((t) => t.status === 'completed')
      .reduce((sum, t) => sum + (t.tokensUsed ?? 0), 0);

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().substring(0, 10);
    const activeContributorIds = new Set(
      projectTasks
        .filter((t) => t.createdAt >= thirtyDaysAgoStr)
        .map((t) => t.contributorId),
    );

    const availableIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.projectId, projectId), eq(issues.status, 'available')))
      .all();

    // Top contributors by tasks completed
    const contributorTaskCounts = new Map<string, number>();
    for (const t of projectTasks.filter((t) => t.status === 'completed')) {
      contributorTaskCounts.set(t.contributorId, (contributorTaskCounts.get(t.contributorId) ?? 0) + 1);
    }

    const topContributorIds = [...contributorTaskCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id]) => id);

    const contributorRows = topContributorIds.length > 0
      ? await db
        .select({ id: contributors.id, githubUsername: contributors.githubUsername })
        .from(contributors)
        .all()
      : [];
    const usernameMap = new Map(contributorRows.map((r) => [r.id, r.githubUsername]));

    const topContributors = topContributorIds.map((id) => ({
      githubUsername: usernameMap.get(id) ?? id,
      tasksCompleted: contributorTaskCounts.get(id) ?? 0,
    }));

    return c.json({
      totalTasksCompleted,
      totalTokensConsumed,
      availableIssues: availableIssues.length,
      activeContributors: activeContributorIds.size,
      topContributors,
    });
  });

  // List issues for a project
  app.get('/:id/issues', async (c) => {
    const projectIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.projectId, c.req.param('id')))
      .all();
    return c.json(projectIssues);
  });

  // Cancel an available issue (e.g. it was closed on GitHub).
  // Only the contributor who registered the project may cancel its issues.
  app.patch('/:id/issues/:issueId/cancel', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const contributor = await getContributorFromToken(db, token);
    if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

    const project = await db
      .select({ registeredBy: projects.registeredBy })
      .from(projects)
      .where(eq(projects.id, c.req.param('id')))
      .get();
    if (!project) return c.json({ error: 'Not found' }, 404);
    if (project.registeredBy !== contributor.githubUsername) return c.json({ error: 'Forbidden' }, 403);

    const issue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.id, c.req.param('issueId')), eq(issues.projectId, c.req.param('id'))))
      .get();
    if (!issue) return c.json({ error: 'Not found' }, 404);
    if (issue.status !== 'available') return c.json({ error: `Cannot cancel issue with status '${issue.status}'` }, 409);

    await db.update(issues).set({ status: 'cancelled' }).where(eq(issues.id, issue.id));
    return c.json({ ok: true });
  });

  return app;
}

function deserializeProject(p: typeof projects.$inferSelect) {
  return {
    ...p,
    languages: JSON.parse(p.languages) as string[],
    taskTypes: JSON.parse(p.taskTypes) as string[],
  };
}
