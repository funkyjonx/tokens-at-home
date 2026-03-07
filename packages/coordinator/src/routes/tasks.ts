import { Hono } from 'hono';
import { and, eq, inArray } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import {
  AssignTaskSchema,
  CompleteTaskSchema,
  FailTaskSchema,
  UpdateTaskStatusSchema,
  ProgressEventSchema,
  PHASE_TIMEOUTS_MS,
} from '@tah/shared';
import type { TaskStatus } from '@tah/shared';
import type { Db } from '../db/index.js';
import { contributors, issues, projects, tasks, taskEvents } from '../db/schema.js';
import {
  getContributorFromToken,
  extractBearerToken,
} from '../services/auth.js';
import { findMatchForContributor } from '../services/matching.js';


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
      phaseStartedAt: now,
    });

    await db
      .update(issues)
      .set({ status: 'assigned', updatedAt: now })
      .where(eq(issues.id, issue.id));

    const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    return c.json(task, 201);
  });

  // Get next task for calling contributor (daemon polling endpoint).
  // Returns an existing dispatched task if one exists; otherwise auto-matches
  // from the contributor's pledges and creates a new task on the spot.
  app.get('/next', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const contributor = await getContributorFromToken(db, token);
    if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

    // 1. Check for an already-dispatched task
    let task = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.contributorId, contributor.id),
          eq(tasks.status, 'dispatched'),
        ),
      )
      .get();

    // 2. No queued task — try auto-matching
    if (!task) {
      const match = await findMatchForContributor(db, contributor.id);
      if (match) {
        // Wrap insert + issue update in a transaction and re-check availability
        // to prevent two workers from being assigned the same issue concurrently.
        const taskId = randomBytes(8).toString('hex');
        const now = new Date().toISOString();

        const created = db.transaction((tx) => {
          const fresh = tx
            .select({ status: issues.status })
            .from(issues)
            .where(eq(issues.id, match.issueId))
            .get();

          if (!fresh || fresh.status !== 'available') return false;

          tx.insert(tasks).values({
            id: taskId,
            issueId: match.issueId,
            contributorId: contributor.id,
            status: 'dispatched',
            phaseStartedAt: now,
          }).run();

          tx.update(issues)
            .set({ status: 'assigned', updatedAt: now })
            .where(eq(issues.id, match.issueId))
            .run();

          return true;
        });

        if (created) {
          task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get();
        }
      }
    }

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
      .set({ phaseStartedAt: now, updatedAt: now })
      .where(eq(tasks.id, task.id));

    return c.json({ ok: true, cancel: false });
  });

  // Progress event (replaces heartbeat — records phase transition and resets phase clock)
  app.post('/:id/progress', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const contributor = await getContributorFromToken(db, token);
    if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

    const task = await db.select().from(tasks).where(eq(tasks.id, c.req.param('id'))).get();
    if (!task) return c.json({ error: 'Not found' }, 404);
    if (task.contributorId !== contributor.id) return c.json({ error: 'Forbidden' }, 403);

    const body = await c.req.json();
    const parsed = ProgressEventSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    // Guard 1: reject terminal phases
    const PROGRESS_PHASES: TaskStatus[] = ['dispatched', 'cloning', 'working', 'review', 'submitting'];
    if (!PROGRESS_PHASES.includes(parsed.data.phase)) {
      return c.json({ error: 'Cannot set terminal status via progress endpoint' }, 400);
    }

    // Guard 2: reject already-terminal tasks
    const TERMINAL_STATUSES: TaskStatus[] = ['completed', 'failed'];
    if (TERMINAL_STATUSES.includes(task.status as TaskStatus)) {
      return c.json({ error: 'Task is already in a terminal state' }, 409);
    }

    const now = new Date().toISOString();
    const eventId = randomBytes(8).toString('hex');

    await db.insert(taskEvents).values({
      id: eventId,
      taskId: task.id,
      phase: parsed.data.phase,
      tokensUsed: parsed.data.tokensUsed ?? null,
      elapsedMs: parsed.data.elapsedMs ?? null,
    });

    await db.update(tasks).set({
      status: parsed.data.phase as TaskStatus,
      phaseStartedAt: now,
      updatedAt: now,
    }).where(eq(tasks.id, task.id));

    return c.json({ ok: true });
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

    const body = await c.req.json();
    const parsed = UpdateTaskStatusSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const now = new Date().toISOString();
    await db
      .update(tasks)
      .set({ status: parsed.data.status, updatedAt: now })
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

  // List all tasks (requires auth, paginated)
  app.get('/', async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Unauthorized' }, 401);
    const contributor = await getContributorFromToken(db, token);
    if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

    const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10) || 100, 500);
    const offset = Math.max(parseInt(c.req.query('offset') ?? '0', 10) || 0, 0);
    const all = await db.select().from(tasks).limit(limit).offset(offset).all();
    return c.json(all);
  });

  return app;
}

// Sweep for timed-out tasks (call on a timer)
export async function abandonStaleTasks(db: Db): Promise<number> {
  const activeStatuses: TaskStatus[] = ['dispatched', 'cloning', 'working', 'review', 'submitting'];

  const activeTasks = await db
    .select()
    .from(tasks)
    .where(inArray(tasks.status, activeStatuses))
    .all();

  const now = Date.now();
  let abandoned = 0;

  for (const task of activeTasks) {
    const timeout = PHASE_TIMEOUTS_MS[task.status as TaskStatus];
    if (!timeout || !task.phaseStartedAt) continue;
    const elapsed = now - new Date(task.phaseStartedAt).getTime();
    if (elapsed <= timeout) continue;

    const timestamp = new Date().toISOString();
    await db.update(tasks).set({
      status: 'failed',
      errorDetails: `Phase '${task.status}' timed out after ${Math.round(elapsed / 60000)}m`,
      updatedAt: timestamp,
    }).where(eq(tasks.id, task.id));

    await db
      .update(issues)
      .set({ status: 'available', updatedAt: timestamp })
      .where(eq(issues.id, task.issueId));

    abandoned++;
  }

  return abandoned;
}
