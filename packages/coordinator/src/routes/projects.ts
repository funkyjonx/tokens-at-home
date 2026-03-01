import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import {
  RegisterProjectSchema,
  RegisterIssueSchema,
  COMPLEXITY_TOKEN_ESTIMATES,
  mapGitHubLabelsToComplexity,
  type IssueComplexity,
} from '@tah/shared';
import type { Db } from '../db/index.js';
import { issues, projects } from '../db/schema.js';
import { getContributorFromToken, extractBearerToken } from '../services/auth.js';

async function fetchGitHubIssueData(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<{ complexity: IssueComplexity | null; body: string | null }> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
      { headers: { 'User-Agent': 'tokens-at-home', Accept: 'application/vnd.github.v3+json' } },
    );
    if (!res.ok) return { complexity: null, body: null };
    const data = await res.json() as { labels?: Array<{ name: string }>; body?: string | null };
    return {
      complexity: mapGitHubLabelsToComplexity((data.labels ?? []).map((l) => l.name)),
      body: data.body ?? null,
    };
  } catch {
    return { complexity: null, body: null };
  }
}

export function projectRoutes(db: Db) {
  const app = new Hono();

  // List all projects
  app.get('/', async (c) => {
    const all = await db.select().from(projects).all();
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
    const needsGitHub = !input.estimatedComplexity || !input.body;
    const gh = needsGitHub
      ? await fetchGitHubIssueData(project.githubOwner, project.githubRepo, input.githubNumber)
      : { complexity: null, body: null };

    const complexity = input.estimatedComplexity ?? gh.complexity ?? 'small';
    const issueBody = input.body || gh.body || '';
    const id = randomBytes(8).toString('hex');

    await db.insert(issues).values({
      id,
      projectId: project.id,
      githubNumber: input.githubNumber,
      title: input.title,
      body: issueBody,
      taskType: input.taskType,
      estimatedComplexity: complexity,
      estimatedTokens: COMPLEXITY_TOKEN_ESTIMATES[complexity],
      status: 'available',
    });

    const issue = await db.select().from(issues).where(eq(issues.id, id)).get();
    return c.json(issue, 201);
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

  return app;
}

function deserializeProject(p: typeof projects.$inferSelect) {
  return {
    ...p,
    languages: JSON.parse(p.languages) as string[],
    taskTypes: JSON.parse(p.taskTypes) as string[],
  };
}
