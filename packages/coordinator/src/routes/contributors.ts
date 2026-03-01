import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import {
  RegisterContributorSchema,
  CreatePledgeSchema,
  SetAvailableSchema,
} from '@tah/shared';
import type { Db } from '../db/index.js';
import { contributors, pledges } from '../db/schema.js';
import {
  createAuthToken,
  getContributorFromToken,
  extractBearerToken,
} from '../services/auth.js';

export function contributorRoutes(db: Db) {
  const app = new Hono();

  // Register a new contributor (no auth required)
  app.post('/', async (c) => {
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

    const id = randomBytes(8).toString('hex');
    await db.insert(pledges).values({
      id,
      contributorId: contributor.id,
      projectId: parsed.data.projectId,
      budgetPercent: parsed.data.budgetPercent,
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

  // Deactivate a pledge (requires auth)
  app.delete('/me/pledges/:pledgeId', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const contributor = await getContributorFromToken(db, token);
    if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

    await db
      .update(pledges)
      .set({ active: false })
      .where(eq(pledges.id, c.req.param('pledgeId')));
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
