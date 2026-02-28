import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import {
  AssignTaskSchema,
  CompleteTaskSchema,
  FailTaskSchema,
} from '@tah/shared';
import type { Db } from '../db/index.js';
import { contributors, issues, projects, tasks } from '../db/schema.js';
import {
  getContributorFromToken,
  extractBearerToken,
} from '../services/auth.js';

// Heartbeats: 5 missed = task abandoned
const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1_000; // 5 min (5 × 60s interval)

export function taskRoutes(db: Db) {
  const app = new Hono();

  // Manual assignment (MVP - no auto-matching)
  app.post('/assign', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const requestor = await getContributorFromToken(db, token);
    if (!requestor) return c.json({ error: 'Unauthorized' }, 401);

    const body = await c.req.json();
    const parsed = AssignTaskSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const issue = await db.select().from(issues).where(eq(issues.id, parsed.data.issueId)).get();
    if (!issue) return c.json({ error: 'Issue not found' }, 404);
    if (issue.status !== 'available') return c.json({ error: 'Issue not available' }, 409);

    const contributor = await db
      .select()
      .from(contributors)
      .where(eq(contributors.id, parsed.data.contributorId))
      .get();
    if (!contributor) return c.json({ error: 'Contributor not found' }, 404);

    const taskId = randomBytes(8).toString('hex');
    const now = new Date().toISOString();

    await db.insert(tasks).values({
      id: taskId,
      issueId: issue.id,
      contributorId: contributor.id,
      status: 'dispatched',
      lastHeartbeatAt: now,
    });

    await db
      .update(issues)
      .set({ status: 'assigned', updatedAt: now })
      .where(eq(issues.id, issue.id));

    const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    return c.json(task, 201);
  });

  // Get next task for calling contributor (daemon polling endpoint)
  app.get('/next', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const contributor = await getContributorFromToken(db, token);
    if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

    const task = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.contributorId, contributor.id),
          eq(tasks.status, 'dispatched'),
        ),
      )
      .get();

    if (!task) return c.body(null, 204);

    // Fetch associated issue and project
    const issue = await db.select().from(issues).where(eq(issues.id, task.issueId)).get();
    const project = issue
      ? await db.select().from(projects).where(eq(projects.id, issue.projectId)).get()
      : null;

    if (!issue || !project) return c.body(null, 204);

    return c.json({
      task,
      issue,
      project: {
        ...project,
        languages: JSON.parse(project.languages) as string[],
        taskTypes: JSON.parse(project.taskTypes) as string[],
      },
    });
  });

  // Get a specific task
  app.get('/:id', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const contributor = await getContributorFromToken(db, token);
    if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

    const task = await db.select().from(tasks).where(eq(tasks.id, c.req.param('id'))).get();
    if (!task) return c.json({ error: 'Not found' }, 404);
    if (task.contributorId !== contributor.id) return c.json({ error: 'Forbidden' }, 403);

    return c.json(task);
  });

  // Heartbeat
  app.post('/:id/heartbeat', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const contributor = await getContributorFromToken(db, token);
    if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

    const task = await db.select().from(tasks).where(eq(tasks.id, c.req.param('id'))).get();
    if (!task) return c.json({ error: 'Not found' }, 404);
    if (task.contributorId !== contributor.id) return c.json({ error: 'Forbidden' }, 403);

    const now = new Date().toISOString();
    await db
      .update(tasks)
      .set({ lastHeartbeatAt: now, updatedAt: now })
      .where(eq(tasks.id, task.id));

    return c.json({ ok: true, cancel: false });
  });

  // Update task status (daemon reports progress)
  app.put('/:id/status', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const contributor = await getContributorFromToken(db, token);
    if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

    const task = await db.select().from(tasks).where(eq(tasks.id, c.req.param('id'))).get();
    if (!task) return c.json({ error: 'Not found' }, 404);
    if (task.contributorId !== contributor.id) return c.json({ error: 'Forbidden' }, 403);

    const { status } = await c.req.json() as { status: string };
    const now = new Date().toISOString();
    await db
      .update(tasks)
      .set({ status, updatedAt: now })
      .where(eq(tasks.id, task.id));

    return c.json({ ok: true });
  });

  // Complete a task
  app.post('/:id/complete', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const contributor = await getContributorFromToken(db, token);
    if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

    const task = await db.select().from(tasks).where(eq(tasks.id, c.req.param('id'))).get();
    if (!task) return c.json({ error: 'Not found' }, 404);
    if (task.contributorId !== contributor.id) return c.json({ error: 'Forbidden' }, 403);

    const body = await c.req.json();
    const parsed = CompleteTaskSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const now = new Date().toISOString();
    await db.update(tasks).set({
      status: 'completed',
      prUrl: parsed.data.prUrl,
      tokensUsed: parsed.data.tokensUsed,
      summary: parsed.data.summary,
      updatedAt: now,
    }).where(eq(tasks.id, task.id));

    await db
      .update(issues)
      .set({ status: 'submitted', updatedAt: now })
      .where(eq(issues.id, task.issueId));

    return c.json({ ok: true });
  });

  // Fail a task
  app.post('/:id/fail', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const contributor = await getContributorFromToken(db, token);
    if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

    const task = await db.select().from(tasks).where(eq(tasks.id, c.req.param('id'))).get();
    if (!task) return c.json({ error: 'Not found' }, 404);
    if (task.contributorId !== contributor.id) return c.json({ error: 'Forbidden' }, 403);

    const body = await c.req.json();
    const parsed = FailTaskSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const now = new Date().toISOString();
    await db.update(tasks).set({
      status: 'failed',
      errorDetails: parsed.data.errorDetails,
      tokensUsed: parsed.data.tokensUsed ?? null,
      updatedAt: now,
    }).where(eq(tasks.id, task.id));

    await db
      .update(issues)
      .set({ status: 'available', updatedAt: now })
      .where(eq(issues.id, task.issueId));

    return c.json({ ok: true });
  });

  // Admin: list all tasks
  app.get('/', async (c) => {
    const all = await db.select().from(tasks).all();
    return c.json(all);
  });

  return app;
}

// Sweep for timed-out tasks (call on a timer)
export async function abandonStaleTasks(db: Db): Promise<number> {
  const allActive = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.status, 'working'),
      ),
    )
    .all();

  const now = Date.now();
  let abandoned = 0;

  for (const task of allActive) {
    if (!task.lastHeartbeatAt) continue;
    const elapsed = now - new Date(task.lastHeartbeatAt).getTime();
    if (elapsed > HEARTBEAT_TIMEOUT_MS) {
      const timestamp = new Date().toISOString();
      await db.update(tasks).set({
        status: 'failed',
        errorDetails: 'Heartbeat timeout - daemon may have crashed',
        updatedAt: timestamp,
      }).where(eq(tasks.id, task.id));

      await db
        .update(issues)
        .set({ status: 'available', updatedAt: timestamp })
        .where(eq(issues.id, task.issueId));

      abandoned++;
    }
  }

  return abandoned;
}
