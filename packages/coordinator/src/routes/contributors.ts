import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import {
  RegisterContributorSchema,
  SetAvailableSchema,
} from '@tah/shared';
import type { Db } from '../db/index.js';
import { contributors, projects, tasks, issues, authTokens, projectPins } from '../db/schema.js';
import {
  createAuthToken,
  getContributorFromToken,
  extractBearerToken,
} from '../services/auth.js';

// Simple in-memory rate limiter for contributor registration (unauthenticated endpoint).
// Allows 5 registrations per IP per 15 minutes.
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const registrationRateLimit = new Map<string, { count: number; windowStart: number }>();

function getClientIp(forwarded: string | undefined, realIp: string | undefined): string {
  if (forwarded) return forwarded.split(',')[0].trim();
  return realIp ?? 'unknown';
}

function checkRateLimit(ip: string): boolean {
  // 'unknown' means no proxy is forwarding the real IP (e.g. local dev or tests)
  if (ip === 'unknown') return true;
  const now = Date.now();
  const entry = registrationRateLimit.get(ip);
  if (entry && now - entry.windowStart < RATE_LIMIT_WINDOW_MS) {
    if (entry.count >= RATE_LIMIT_MAX) return false;
    entry.count++;
  } else {
    registrationRateLimit.set(ip, { count: 1, windowStart: now });
  }
  // Periodically prune stale entries (1% chance per call)
  if (Math.random() < 0.01) {
    for (const [k, v] of registrationRateLimit) {
      if (now - v.windowStart > RATE_LIMIT_WINDOW_MS) registrationRateLimit.delete(k);
    }
  }
  return true;
}

export function contributorRoutes(db: Db) {
  const app = new Hono();

  // Public contributor directory (no auth required)
  app.get('/', async (c) => {
    const q = c.req.query('q');
    const language = c.req.query('language');
    const sort = c.req.query('sort') ?? 'tasks';
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 200);
    const offset = Math.max(parseInt(c.req.query('offset') ?? '0', 10) || 0, 0);

    // Get all completed tasks grouped by contributor for stats
    const taskStats = await db
      .select({
        contributorId: tasks.contributorId,
        count: sql<number>`count(*)`,
        tokens: sql<number>`sum(coalesce(${tasks.tokensUsed}, 0))`,
      })
      .from(tasks)
      .where(eq(tasks.status, 'completed'))
      .groupBy(tasks.contributorId)
      .all();

    const statsMap = new Map(taskStats.map((r) => [r.contributorId, { count: r.count, tokens: r.tokens }]));

    // Fetch contributors — only those with ≥1 completed task
    const eligibleIds = [...statsMap.keys()];
    if (eligibleIds.length === 0) return c.json([]);

    let allContributors = await db
      .select({
        id: contributors.id,
        githubUsername: contributors.githubUsername,
        languages: contributors.languages,
        trustScore: contributors.trustScore,
        createdAt: contributors.createdAt,
      })
      .from(contributors)
      .all();

    // Filter to only eligible contributors
    allContributors = allContributors.filter((c) => statsMap.has(c.id));

    // Apply search filter
    if (q) {
      const lower = q.toLowerCase();
      allContributors = allContributors.filter((c) =>
        c.githubUsername.toLowerCase().includes(lower),
      );
    }
    if (language) {
      allContributors = allContributors.filter((c) => {
        const langs = JSON.parse(c.languages) as string[];
        return langs.includes(language);
      });
    }

    // Sort
    if (sort === 'tokens') {
      allContributors.sort((a, b) => (statsMap.get(b.id)?.tokens ?? 0) - (statsMap.get(a.id)?.tokens ?? 0));
    } else {
      allContributors.sort((a, b) => (statsMap.get(b.id)?.count ?? 0) - (statsMap.get(a.id)?.count ?? 0));
    }

    const results = allContributors.slice(offset, offset + limit).map((c) => ({
      id: c.id,
      githubUsername: c.githubUsername,
      languages: JSON.parse(c.languages) as string[],
      trustScore: c.trustScore,
      tasksCompleted: statsMap.get(c.id)?.count ?? 0,
      totalTokensDonated: statsMap.get(c.id)?.tokens ?? 0,
      memberSince: c.createdAt,
    }));

    return c.json(results);
  });

  // Register a new contributor (no auth required)
  app.post('/', async (c) => {
    const ip = getClientIp(c.req.header('X-Forwarded-For'), c.req.header('X-Real-IP'));
    if (!checkRateLimit(ip)) {
      return c.json({ error: 'Too many registration attempts — try again later' }, 429);
    }

    const body = await c.req.json();
    const parsed = RegisterContributorSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const input = parsed.data;

    // Check if already registered
    const existing = await db
      .select()
      .from(contributors)
      .where(eq(contributors.githubUsername, input.githubUsername))
      .get();
    if (existing) return c.json({ error: 'Username already registered' }, 409);

    const id = randomBytes(8).toString('hex');
    await db.insert(contributors).values({
      id,
      githubUsername: input.githubUsername,
      languages: JSON.stringify(input.languages),
      maxConcurrent: input.maxConcurrent,
      trustScore: 0,
      available: false,
    });

    // Issue an auth token for daemon/CLI use
    const token = await createAuthToken(db, id);

    const contributor = await db.select().from(contributors).where(eq(contributors.id, id)).get();
    return c.json({ contributor: deserializeContributor(contributor!), token }, 201);
  });

  // Get own profile (requires auth)
  app.get('/me', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const contributor = await getContributorFromToken(db, token);
    if (!contributor) return c.json({ error: 'Unauthorized' }, 401);
    return c.json(deserializeContributor(contributor));
  });

  // Set availability (requires auth)
  app.put('/me/available', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const contributor = await getContributorFromToken(db, token);
    if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

    const body = await c.req.json();
    const parsed = SetAvailableSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    await db
      .update(contributors)
      .set({ available: parsed.data.available })
      .where(eq(contributors.id, contributor.id));

    return c.json({ ok: true, available: parsed.data.available });
  });

  // POST /me/pins — pin a project
  app.post('/me/pins', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const contributor = await getContributorFromToken(db, token);
    if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

    const body = await c.req.json().catch(() => ({})) as { projectId?: string };
    if (!body.projectId || typeof body.projectId !== 'string') {
      return c.json({ error: 'projectId required' }, 400);
    }

    const project = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, body.projectId))
      .get();
    if (!project) return c.json({ error: 'Project not found' }, 404);

    const existing = await db
      .select({ id: projectPins.id })
      .from(projectPins)
      .where(and(eq(projectPins.contributorId, contributor.id), eq(projectPins.projectId, body.projectId)))
      .get();
    if (existing) return c.json({ error: 'Already pinned' }, 409);

    const id = randomBytes(8).toString('hex');
    await db.insert(projectPins).values({ id, contributorId: contributor.id, projectId: body.projectId });
    const pin = await db.select().from(projectPins).where(eq(projectPins.id, id)).get();
    return c.json(pin, 201);
  });

  // DELETE /me/pins/:projectId — unpin a project
  app.delete('/me/pins/:projectId', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const contributor = await getContributorFromToken(db, token);
    if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

    const pin = await db
      .select({ id: projectPins.id })
      .from(projectPins)
      .where(and(eq(projectPins.contributorId, contributor.id), eq(projectPins.projectId, c.req.param('projectId'))))
      .get();
    if (!pin) return c.json({ error: 'Not found' }, 404);

    await db.delete(projectPins).where(eq(projectPins.id, pin.id));
    return c.json({ ok: true });
  });

  // GET /me/pins — list pinned projects
  app.get('/me/pins', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const contributor = await getContributorFromToken(db, token);
    if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

    const pins = await db
      .select({
        id: projectPins.id,
        projectId: projectPins.projectId,
        createdAt: projectPins.createdAt,
        githubOwner: projects.githubOwner,
        githubRepo: projects.githubRepo,
      })
      .from(projectPins)
      .innerJoin(projects, eq(projectPins.projectId, projects.id))
      .where(eq(projectPins.contributorId, contributor.id))
      .all();

    return c.json(pins);
  });

  app.get('/:username/stats', async (c) => {
    const { username } = c.req.param();
    const contributor = await db.select().from(contributors)
      .where(eq(contributors.githubUsername, username)).get();
    if (!contributor) return c.json({ error: 'Not found' }, 404);

    const allTasks = await db.select({
      status: tasks.status, tokensUsed: tasks.tokensUsed,
      createdAt: tasks.createdAt, issueId: tasks.issueId,
    }).from(tasks).where(eq(tasks.contributorId, contributor.id)).all();

    const completed = allTasks.filter((t) => t.status === 'completed');
    const failed = allTasks.filter((t) => t.status === 'failed');
    const totalTokens = completed.reduce((s, t) => s + (t.tokensUsed ?? 0), 0);
    const successRate = (completed.length + failed.length) > 0
      ? completed.length / (completed.length + failed.length) : 0;

    const monthAgo = new Date(); monthAgo.setDate(monthAgo.getDate() - 30);
    const thisMonthCompleted = completed.filter((t) => new Date(t.createdAt) >= monthAgo);
    const thisMonthTokens = thisMonthCompleted.reduce((s, t) => s + (t.tokensUsed ?? 0), 0);

    const allStats = await db.select({
      contributorId: tasks.contributorId,
      tokens: sql<number>`sum(coalesce(${tasks.tokensUsed}, 0))`,
    }).from(tasks).where(eq(tasks.status, 'completed')).groupBy(tasks.contributorId)
      .orderBy(sql`tokens DESC`).all();
    const allTimeRank = allStats.findIndex((r) => r.contributorId === contributor.id) + 1;

    const monthStats = await db.select({
      contributorId: tasks.contributorId,
      tokens: sql<number>`sum(coalesce(${tasks.tokensUsed}, 0))`,
    }).from(tasks).where(and(eq(tasks.status, 'completed'), sql`${tasks.createdAt} >= datetime('now', '-30 days')`))
      .groupBy(tasks.contributorId).orderBy(sql`tokens DESC`).all();
    const monthRank = monthStats.findIndex((r) => r.contributorId === contributor.id) + 1;

    const projectTaskCounts = new Map<string, number>();
    for (const t of completed) {
      const issue = await db.select({ projectId: issues.projectId }).from(issues)
        .where(eq(issues.id, t.issueId)).get();
      if (issue) projectTaskCounts.set(issue.projectId, (projectTaskCounts.get(issue.projectId) ?? 0) + 1);
    }
    const topProjectIds = [...projectTaskCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const topProjects = (await Promise.all(topProjectIds.map(async ([pid, count]) => {
      const p = await db.select({ githubOwner: projects.githubOwner, githubRepo: projects.githubRepo })
        .from(projects).where(eq(projects.id, pid)).get();
      return p ? { ...p, tasksCompleted: count } : null;
    }))).filter(Boolean);

    return c.json({
      githubUsername: contributor.githubUsername,
      memberSince: contributor.createdAt,
      allTime: { tasksCompleted: completed.length, tokensDonated: totalTokens, successRate, rank: allTimeRank },
      thisMonth: { tasksCompleted: thisMonthCompleted.length, tokensDonated: thisMonthTokens, rank: monthRank },
      topProjects,
      bestStreak: 0,
      currentStreak: 0,
    });
  });

  app.delete('/me', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const contributor = await getContributorFromToken(db, token);
    if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

    // For safety, we just mark as unavailable and remove auth tokens.
    // We don't delete the contributor record to preserve task history.
    await db
      .update(contributors)
      .set({ available: false })
      .where(eq(contributors.id, contributor.id));

    await db.delete(authTokens).where(eq(authTokens.contributorId, contributor.id));

    return c.json({ ok: true, message: 'Contributor deregistered and tokens revoked.' });
  });

  return app;
}

function deserializeContributor(c: typeof contributors.$inferSelect) {
  const { trustScore, ...rest } = c;
  void trustScore; // intentionally omitted
  return {
    ...rest,
    languages: JSON.parse(c.languages) as string[],
    available: Boolean(c.available),
  };
}
