import { Hono } from 'hono';
import { and, desc, eq, sql } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import {
  RegisterContributorSchema,
  CreatePledgeSchema,
  SetAvailableSchema,
  AddToWatchlistSchema,
  CreateGenericPledgeSchema,
} from '@tah/shared';
import type { Db } from '../db/index.js';
import { contributors, pledges, projects, tasks, authTokens, watchlist, genericPledges } from '../db/schema.js';
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

    // New contributors start with trustScore = 0 and are locked to review_before_pr
    // regardless of what they request. Full autonomy is unlocked once trust is earned.
    const id = randomBytes(8).toString('hex');
    await db.insert(contributors).values({
      id,
      githubUsername: input.githubUsername,
      languages: JSON.stringify(input.languages),
      autonomy: 'review_before_pr',
      cycleResetDate: input.cycleResetDate ?? null,
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

  // Create a pledge (requires auth)
  app.post('/me/pledges', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const contributor = await getContributorFromToken(db, token);
    if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

    const body = await c.req.json();
    const parsed = CreatePledgeSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    // Verify the project exists
    const project = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, parsed.data.projectId))
      .get();
    if (!project) return c.json({ error: 'Project not found' }, 404);

    // Reject duplicate active pledge for same project
    const existingPledge = await db
      .select({ id: pledges.id })
      .from(pledges)
      .where(and(
        eq(pledges.contributorId, contributor.id),
        eq(pledges.projectId, parsed.data.projectId),
        eq(pledges.active, true),
      ))
      .get();
    if (existingPledge) return c.json({ error: 'Active pledge already exists for this project' }, 409);

    const id = randomBytes(8).toString('hex');
    await db.insert(pledges).values({
      id,
      contributorId: contributor.id,
      projectId: parsed.data.projectId,
      maxTasks: parsed.data.maxTasks,
      maxComplexity: parsed.data.maxComplexity,
      active: true,
    });

    const pledge = await db.select().from(pledges).where(eq(pledges.id, id)).get();
    return c.json(pledge, 201);
  });

  // List own pledges (requires auth)
  app.get('/me/pledges', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const contributor = await getContributorFromToken(db, token);
    if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

    const contributorPledges = await db
      .select()
      .from(pledges)
      .where(eq(pledges.contributorId, contributor.id))
      .all();

    // Fetch task counts for each pledge
    const pledgeIds = contributorPledges.map((p) => p.id);
    const taskCounts = await db
      .select({ pledgeId: tasks.pledgeId, count: sql<number>`count(*)` })
      .from(tasks)
      .where(and(
        eq(tasks.contributorId, contributor.id),
        sql`${tasks.pledgeId} IN ${pledgeIds.length > 0 ? pledgeIds : ['none']}`,
        eq(tasks.status, 'completed'),
      ))
      .groupBy(tasks.pledgeId)
      .all();

    const countMap = new Map(taskCounts.map((tc) => [tc.pledgeId, tc.count]));

    const results = contributorPledges.map((p) => ({
      ...p,
      active: Boolean(p.active),
      completedTasks: countMap.get(p.id) ?? 0,
    }));

    return c.json(results);
  });

  // Deactivate a pledge (requires auth, must own the pledge)
  app.delete('/me/pledges/:pledgeId', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const contributor = await getContributorFromToken(db, token);
    if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

    const pledge = await db
      .select({ id: pledges.id, contributorId: pledges.contributorId })
      .from(pledges)
      .where(eq(pledges.id, c.req.param('pledgeId')))
      .get();
    if (!pledge) return c.json({ error: 'Not found' }, 404);
    if (pledge.contributorId !== contributor.id) return c.json({ error: 'Forbidden' }, 403);

    await db
      .update(pledges)
      .set({ active: false })
      .where(eq(pledges.id, pledge.id));
    return c.json({ ok: true });
  });

  // --- Watchlist endpoints ---

  // Add a project to watchlist
  app.post('/me/watchlist', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const contributor = await getContributorFromToken(db, token);
    if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

    const body = await c.req.json();
    const parsed = AddToWatchlistSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const project = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, parsed.data.projectId))
      .get();
    if (!project) return c.json({ error: 'Project not found' }, 404);

    const existing = await db
      .select({ id: watchlist.id })
      .from(watchlist)
      .where(and(
        eq(watchlist.contributorId, contributor.id),
        eq(watchlist.projectId, parsed.data.projectId),
      ))
      .get();
    if (existing) return c.json({ error: 'Project already on watchlist' }, 409);

    const id = randomBytes(8).toString('hex');
    await db.insert(watchlist).values({
      id,
      contributorId: contributor.id,
      projectId: parsed.data.projectId,
    });

    const entry = await db.select().from(watchlist).where(eq(watchlist.id, id)).get();
    return c.json(entry, 201);
  });

  // Remove a project from watchlist
  app.delete('/me/watchlist/:projectId', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const contributor = await getContributorFromToken(db, token);
    if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

    const entry = await db
      .select({ id: watchlist.id })
      .from(watchlist)
      .where(and(
        eq(watchlist.contributorId, contributor.id),
        eq(watchlist.projectId, c.req.param('projectId')),
      ))
      .get();
    if (!entry) return c.json({ error: 'Not found' }, 404);

    await db.delete(watchlist).where(eq(watchlist.id, entry.id));
    return c.json({ ok: true });
  });

  // List watchlist (with project names)
  app.get('/me/watchlist', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const contributor = await getContributorFromToken(db, token);
    if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

    const entries = await db
      .select({
        id: watchlist.id,
        contributorId: watchlist.contributorId,
        projectId: watchlist.projectId,
        createdAt: watchlist.createdAt,
        githubOwner: projects.githubOwner,
        githubRepo: projects.githubRepo,
      })
      .from(watchlist)
      .innerJoin(projects, eq(watchlist.projectId, projects.id))
      .where(eq(watchlist.contributorId, contributor.id))
      .all();

    return c.json(entries);
  });

  // --- Generic pledge endpoints ---

  // Create a generic pledge
  app.post('/me/generic-pledges', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const contributor = await getContributorFromToken(db, token);
    if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

    const body = await c.req.json();
    const parsed = CreateGenericPledgeSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const id = randomBytes(8).toString('hex');
    await db.insert(genericPledges).values({
      id,
      contributorId: contributor.id,
      maxTasks: parsed.data.maxTasks,
      maxComplexity: parsed.data.maxComplexity,
      active: true,
    });

    const pledge = await db.select().from(genericPledges).where(eq(genericPledges.id, id)).get();
    return c.json({ ...pledge, active: Boolean(pledge!.active) }, 201);
  });

  // List generic pledges (with completed task counts)
  app.get('/me/generic-pledges', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const contributor = await getContributorFromToken(db, token);
    if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

    const allPledges = await db
      .select()
      .from(genericPledges)
      .where(eq(genericPledges.contributorId, contributor.id))
      .all();

    const pledgeIds = allPledges.map((p) => p.id);
    const taskCounts = await db
      .select({ pledgeId: tasks.pledgeId, count: sql<number>`count(*)` })
      .from(tasks)
      .where(and(
        eq(tasks.contributorId, contributor.id),
        sql`${tasks.pledgeId} IN ${pledgeIds.length > 0 ? pledgeIds : ['none']}`,
        eq(tasks.status, 'completed'),
      ))
      .groupBy(tasks.pledgeId)
      .all();

    const countMap = new Map(taskCounts.map((tc) => [tc.pledgeId, tc.count]));

    return c.json(allPledges.map((p) => ({
      ...p,
      active: Boolean(p.active),
      completedTasks: countMap.get(p.id) ?? 0,
    })));
  });

  // Deactivate a generic pledge
  app.delete('/me/generic-pledges/:pledgeId', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const contributor = await getContributorFromToken(db, token);
    if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

    const pledge = await db
      .select({ id: genericPledges.id, contributorId: genericPledges.contributorId })
      .from(genericPledges)
      .where(eq(genericPledges.id, c.req.param('pledgeId')))
      .get();
    if (!pledge) return c.json({ error: 'Not found' }, 404);
    if (pledge.contributorId !== contributor.id) return c.json({ error: 'Forbidden' }, 403);

    await db
      .update(genericPledges)
      .set({ active: false })
      .where(eq(genericPledges.id, pledge.id));
    return c.json({ ok: true });
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
  return {
    ...c,
    languages: JSON.parse(c.languages) as string[],
    available: Boolean(c.available),
  };
}
