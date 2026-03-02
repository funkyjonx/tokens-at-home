import { Hono } from 'hono';
import { eq, or } from 'drizzle-orm';
import type { ActivityEvent } from '@tah/shared';
import type { Db } from '../db/index.js';
import { contributors, issues, pledges, projects, tasks } from '../db/schema.js';

export function eventRoutes(db: Db) {
  const app = new Hono();

  app.get('/', async (c) => {
    const events: ActivityEvent[] = [];

    // Project registrations
    const allProjects = await db.select().from(projects).all();
    for (const p of allProjects) {
      events.push({
        type: 'project_registered',
        ts: p.createdAt,
        actor: p.registeredBy,
        project: `${p.githubOwner}/${p.githubRepo}`,
        projectId: p.id,
      });
    }

    // Contributor registrations
    const allContributors = await db.select().from(contributors).all();
    for (const contrib of allContributors) {
      events.push({
        type: 'contributor_joined',
        ts: contrib.createdAt,
        actor: contrib.githubUsername,
      });
    }

    // Pledges (joined with contributor and project names)
    const allPledges = await db
      .select({
        createdAt: pledges.createdAt,
        maxTasks: pledges.maxTasks,
        maxComplexity: pledges.maxComplexity,
        contributorUsername: contributors.githubUsername,
        githubOwner: projects.githubOwner,
        githubRepo: projects.githubRepo,
      })
      .from(pledges)
      .innerJoin(contributors, eq(pledges.contributorId, contributors.id))
      .innerJoin(projects, eq(pledges.projectId, projects.id))
      .all();
    for (const pl of allPledges) {
      events.push({
        type: 'pledge_created',
        ts: pl.createdAt,
        actor: pl.contributorUsername,
        project: `${pl.githubOwner}/${pl.githubRepo}`,
        maxTasks: pl.maxTasks,
        maxComplexity: pl.maxComplexity,
      });
    }

    // Completed and failed tasks (joined with contributor, issue, and project)
    const terminalTasks = await db
      .select({
        status: tasks.status,
        tokensUsed: tasks.tokensUsed,
        prUrl: tasks.prUrl,
        errorDetails: tasks.errorDetails,
        updatedAt: tasks.updatedAt,
        contributorUsername: contributors.githubUsername,
        issueNumber: issues.githubNumber,
        githubOwner: projects.githubOwner,
        githubRepo: projects.githubRepo,
      })
      .from(tasks)
      .innerJoin(contributors, eq(tasks.contributorId, contributors.id))
      .innerJoin(issues, eq(tasks.issueId, issues.id))
      .innerJoin(projects, eq(issues.projectId, projects.id))
      .where(or(eq(tasks.status, 'completed'), eq(tasks.status, 'failed')))
      .all();
    for (const t of terminalTasks) {
      if (t.status === 'completed') {
        events.push({
          type: 'task_completed',
          ts: t.updatedAt,
          actor: t.contributorUsername,
          project: `${t.githubOwner}/${t.githubRepo}`,
          issueNumber: t.issueNumber,
          tokensUsed: t.tokensUsed ?? 0,
          prUrl: t.prUrl ?? '',
        });
      } else {
        events.push({
          type: 'task_failed',
          ts: t.updatedAt,
          actor: t.contributorUsername,
          project: `${t.githubOwner}/${t.githubRepo}`,
          issueNumber: t.issueNumber,
          ...(t.errorDetails ? { errorDetails: t.errorDetails } : {}),
        });
      }
    }

    // Sort descending by timestamp (most recent first)
    events.sort((a, b) => b.ts.localeCompare(a.ts));

    return c.json(events);
  });

  return app;
}
