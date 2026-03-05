import { Hono } from 'hono';
import { eq, or, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { contributors, tasks } from '../db/schema.js';
import type { LeaderboardEntry, LeaderboardPeriod, LeaderboardSort } from '@tah/shared';

function computeStreak(dates: string[]): number {
  if (dates.length === 0) return 0;
  // Get unique days (YYYY-MM-DD), sort descending
  const uniqueDays = [...new Set(dates.map((d) => d.substring(0, 10)))].sort().reverse();

  const today = new Date();
  const todayStr = today.toISOString().substring(0, 10);

  // Streak must start from today or yesterday
  if (uniqueDays[0] !== todayStr) {
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().substring(0, 10);
    if (uniqueDays[0] !== yesterdayStr) return 0;
  }

  let streak = 0;
  for (let i = 0; i < uniqueDays.length; i++) {
    const expected = new Date(today);
    expected.setDate(today.getDate() - i);
    const expectedStr = expected.toISOString().substring(0, 10);
    if (uniqueDays[i] === expectedStr) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

export function leaderboardRoutes(db: Db) {
  const app = new Hono();

  app.get('/', async (c) => {
    const period = (c.req.query('period') ?? 'all') as LeaderboardPeriod;
    const sort = (c.req.query('sort') ?? 'tokens') as LeaderboardSort;
    const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10) || 20, 100);

    // Build period filter for stats (tokens/tasks)
    const periodSql =
      period === 'week'
        ? sql`${tasks.createdAt} >= datetime('now', '-7 days')`
        : period === 'month'
          ? sql`${tasks.createdAt} >= datetime('now', '-30 days')`
          : null;

    const statusFilter = or(eq(tasks.status, 'completed'), eq(tasks.status, 'failed'))!;
    const whereClause = periodSql ? sql`(${statusFilter}) AND (${periodSql})` : statusFilter;

    // Fetch tasks for period-filtered stats
    const taskRows = await db
      .select({
        contributorId: tasks.contributorId,
        status: tasks.status,
        tokensUsed: tasks.tokensUsed,
      })
      .from(tasks)
      .where(whereClause)
      .all();

    // Fetch all completed tasks (for streak computation — always full history)
    const allCompletedRows = await db
      .select({
        contributorId: tasks.contributorId,
        createdAt: tasks.createdAt,
      })
      .from(tasks)
      .where(eq(tasks.status, 'completed'))
      .all();

    // Aggregate per contributor
    const statsMap = new Map<string, { completed: number; failed: number; totalTokens: number }>();
    for (const row of taskRows) {
      const entry = statsMap.get(row.contributorId) ?? { completed: 0, failed: 0, totalTokens: 0 };
      if (row.status === 'completed') {
        entry.completed++;
        entry.totalTokens += row.tokensUsed ?? 0;
      } else {
        entry.failed++;
      }
      statsMap.set(row.contributorId, entry);
    }

    // Collect completed dates per contributor for streak
    const datesMap = new Map<string, string[]>();
    for (const row of allCompletedRows) {
      const dates = datesMap.get(row.contributorId) ?? [];
      dates.push(row.createdAt);
      datesMap.set(row.contributorId, dates);
    }

    // Only include contributors with ≥1 completed task in the period
    const eligibleIds = [...statsMap.keys()].filter((id) => (statsMap.get(id)?.completed ?? 0) > 0);
    if (eligibleIds.length === 0) return c.json([] as LeaderboardEntry[]);

    // Fetch usernames
    const contributorRows = await db
      .select({ id: contributors.id, githubUsername: contributors.githubUsername })
      .from(contributors)
      .all();
    const usernameMap = new Map(contributorRows.map((r) => [r.id, r.githubUsername]));

    // Build entries
    let entries: LeaderboardEntry[] = eligibleIds.map((id) => {
      const stats = statsMap.get(id)!;
      const total = stats.completed + stats.failed;
      return {
        rank: 0,
        githubUsername: usernameMap.get(id) ?? id,
        totalTokensDonated: stats.totalTokens,
        tasksCompleted: stats.completed,
        successRate: total > 0 ? stats.completed / total : 0,
        currentStreak: computeStreak(datesMap.get(id) ?? []),
      };
    });

    // Sort
    if (sort === 'tokens') {
      entries.sort((a, b) => b.totalTokensDonated - a.totalTokensDonated);
    } else if (sort === 'tasks') {
      entries.sort((a, b) => b.tasksCompleted - a.tasksCompleted);
    } else {
      entries.sort((a, b) => b.currentStreak - a.currentStreak);
    }

    // Assign ranks and limit
    entries = entries.slice(0, limit).map((e, i) => ({ ...e, rank: i + 1 }));

    return c.json(entries);
  });

  return app;
}
