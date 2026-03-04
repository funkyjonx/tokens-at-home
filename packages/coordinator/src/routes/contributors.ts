import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import {
  RegisterContributorSchema,
  CreatePledgeSchema,
  SetAvailableSchema,
} from '@tah/shared';
import type { Db } from '../db/index.js';
import { contributors, pledges, projects } from '../db/schema.js';
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
    return c.json(contributorPledges);
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

  return app;
}

function deserializeContributor(c: typeof contributors.$inferSelect) {
  return {
    ...c,
    languages: JSON.parse(c.languages) as string[],
    available: Boolean(c.available),
  };
}
