import { Hono } from 'hono';
import { html } from 'hono/html';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { contributors, issues, projects, tasks } from '../db/schema.js';
import type { LeaderboardEntry, PublicContributor, ProjectStats } from '@tah/shared';

// ---- Shared layout ----

function layout(title: string, content: unknown) {
  return html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Tokens at Home</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f8f9fa; color: #212529; line-height: 1.5; }
    a { color: #0d6efd; text-decoration: none; }
    a:hover { text-decoration: underline; }
    nav { background: #1a1a2e; padding: 0.75rem 1.5rem; display: flex; align-items: center; gap: 1.5rem; }
    nav .brand { color: #fff; font-weight: 700; font-size: 1.1rem; }
    nav a { color: #adb5bd; font-size: 0.9rem; }
    nav a:hover { color: #fff; text-decoration: none; }
    .container { max-width: 960px; margin: 2rem auto; padding: 0 1rem; }
    h1 { font-size: 1.75rem; margin-bottom: 1rem; }
    h2 { font-size: 1.25rem; margin: 1.5rem 0 0.75rem; }
    .card { background: #fff; border: 1px solid #dee2e6; border-radius: 8px; padding: 1.25rem; margin-bottom: 1rem; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
    .stat-card { background: #fff; border: 1px solid #dee2e6; border-radius: 8px; padding: 1rem; text-align: center; }
    .stat-card .value { font-size: 2rem; font-weight: 700; color: #0d6efd; }
    .stat-card .label { font-size: 0.85rem; color: #6c757d; margin-top: 0.25rem; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; border: 1px solid #dee2e6; }
    th { background: #f1f3f5; padding: 0.75rem 1rem; text-align: left; font-size: 0.85rem; color: #495057; border-bottom: 1px solid #dee2e6; }
    td { padding: 0.75rem 1rem; border-bottom: 1px solid #f1f3f5; font-size: 0.9rem; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #f8f9fa; }
    .badge { display: inline-block; padding: 0.2em 0.55em; border-radius: 4px; font-size: 0.75rem; background: #e9ecef; color: #495057; margin: 0.1em; }
    form.search { display: flex; gap: 0.5rem; margin-bottom: 1.25rem; flex-wrap: wrap; }
    form.search input, form.search select { padding: 0.45rem 0.75rem; border: 1px solid #ced4da; border-radius: 6px; font-size: 0.9rem; }
    form.search button { padding: 0.45rem 1rem; background: #0d6efd; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 0.9rem; }
    form.search button:hover { background: #0b5ed7; }
    .empty { color: #6c757d; padding: 2rem; text-align: center; }
    .rank { font-weight: 700; color: #6c757d; }
    .rank-1 { color: #ffc107; }
    .rank-2 { color: #adb5bd; }
    .rank-3 { color: #cd7f32; }
    .period-tabs { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
    .period-tabs a { padding: 0.35rem 0.8rem; border-radius: 6px; font-size: 0.85rem; color: #495057; background: #e9ecef; }
    .period-tabs a.active { background: #0d6efd; color: #fff; }
    footer { text-align: center; padding: 2rem; color: #6c757d; font-size: 0.85rem; }
    footer a { color: #6c757d; }
  </style>
</head>
<body>
  <nav>
    <span class="brand">Tokens at Home</span>
    <a href="/ui">Dashboard</a>
    <a href="/ui/projects">Projects</a>
    <a href="/ui/contributors">Contributors</a>
    <a href="/ui/leaderboard">Leaderboard</a>
  </nav>
  <div class="container">
    ${content}
  </div>
  <footer>
    <a href="https://github.com/tokens-at-home/tah" target="_blank">GitHub</a>
  </footer>
</body>
</html>`;
}

// ---- Helpers ----

function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtPct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function uiRoutes(db: Db) {
  const app = new Hono();

  // Dashboard
  app.get('/', async (c) => {
    const [totalProjects, totalContributors] = await Promise.all([
      db.select({ count: sql<number>`count(*)` }).from(projects).get(),
      db.select({ count: sql<number>`count(*)` }).from(contributors).get(),
    ]);

    const taskStats = await db
      .select({
        completed: sql<number>`sum(case when status = 'completed' then 1 else 0 end)`,
        tokens: sql<number>`sum(case when status = 'completed' then coalesce(tokens_used, 0) else 0 end)`,
      })
      .from(tasks)
      .get();

    // Recent activity: last 20 completed tasks with contributor and issue info
    const recentTasks = await db
      .select({
        id: tasks.id,
        status: tasks.status,
        tokensUsed: tasks.tokensUsed,
        createdAt: tasks.createdAt,
        githubUsername: contributors.githubUsername,
        issueTitle: issues.title,
        githubNumber: issues.githubNumber,
        githubOwner: projects.githubOwner,
        githubRepo: projects.githubRepo,
      })
      .from(tasks)
      .innerJoin(contributors, eq(tasks.contributorId, contributors.id))
      .innerJoin(issues, eq(tasks.issueId, issues.id))
      .innerJoin(projects, eq(issues.projectId, projects.id))
      .where(eq(tasks.status, 'completed'))
      .orderBy(sql`${tasks.updatedAt} DESC`)
      .limit(20)
      .all();

    const content = html`
      <h1>Platform Dashboard</h1>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="value">${fmtNum(totalProjects?.count ?? 0)}</div>
          <div class="label">Projects</div>
        </div>
        <div class="stat-card">
          <div class="value">${fmtNum(totalContributors?.count ?? 0)}</div>
          <div class="label">Contributors</div>
        </div>
        <div class="stat-card">
          <div class="value">${fmtNum(taskStats?.completed ?? 0)}</div>
          <div class="label">Tasks Completed</div>
        </div>
        <div class="stat-card">
          <div class="value">${fmtNum(Math.round((taskStats?.tokens ?? 0) / 1000))}K</div>
          <div class="label">Tokens Donated</div>
        </div>
      </div>
      <h2>Recent Activity</h2>
      ${recentTasks.length === 0
        ? html`<p class="empty">No completed tasks yet.</p>`
        : html`<table>
          <thead><tr><th>Contributor</th><th>Project</th><th>Issue</th><th>Tokens</th><th>Date</th></tr></thead>
          <tbody>
            ${recentTasks.map((t) => html`<tr>
              <td><a href="/ui/contributors?q=${t.githubUsername}">${t.githubUsername}</a></td>
              <td><a href="/ui/projects">${t.githubOwner}/${t.githubRepo}</a></td>
              <td>#${t.githubNumber} ${t.issueTitle}</td>
              <td>${fmtNum(t.tokensUsed ?? 0)}</td>
              <td>${(t.createdAt ?? '').substring(0, 10)}</td>
            </tr>`)}
          </tbody>
        </table>`
      }
    `;

    return c.html(layout('Dashboard', content) as unknown as string);
  });

  // Projects list
  app.get('/projects', async (c) => {
    const q = c.req.query('q') ?? '';
    const language = c.req.query('language') ?? '';

    let allProjects = await db
      .select()
      .from(projects)
      .orderBy(sql`${projects.createdAt} DESC`)
      .all();

    if (q) {
      const lower = q.toLowerCase();
      allProjects = allProjects.filter(
        (p) => p.githubOwner.toLowerCase().includes(lower) || p.githubRepo.toLowerCase().includes(lower),
      );
    }
    if (language) {
      allProjects = allProjects.filter((p) => {
        const langs = JSON.parse(p.languages) as string[];
        return langs.includes(language);
      });
    }

    // Get issue counts per project
    const issueCounts = await db
      .select({ projectId: issues.projectId, count: sql<number>`count(*)` })
      .from(issues)
      .where(eq(issues.status, 'available'))
      .groupBy(issues.projectId)
      .all();
    const issueCountMap = new Map(issueCounts.map((r) => [r.projectId, r.count]));

    const content = html`
      <h1>Projects</h1>
      <form class="search" method="get" action="/ui/projects">
        <input name="q" placeholder="Search owner or repo..." value="${q}" />
        <input name="language" placeholder="Language (e.g. typescript)" value="${language}" />
        <button type="submit">Search</button>
        ${(q || language) ? html`<a href="/ui/projects" style="padding:0.45rem 0.75rem;color:#6c757d">Clear</a>` : ''}
      </form>
      ${allProjects.length === 0
        ? html`<p class="empty">No projects found.</p>`
        : html`<table>
          <thead><tr><th>Project</th><th>Languages</th><th>Available Issues</th><th>Registered</th></tr></thead>
          <tbody>
            ${allProjects.map((p) => {
              const langs = JSON.parse(p.languages) as string[];
              return html`<tr>
                <td><a href="/ui/projects/${p.id}">${p.githubOwner}/${p.githubRepo}</a></td>
                <td>${langs.map((l) => html`<span class="badge">${l}</span>`)}</td>
                <td>${fmtNum(issueCountMap.get(p.id) ?? 0)}</td>
                <td>${p.createdAt.substring(0, 10)}</td>
              </tr>`;
            })}
          </tbody>
        </table>`
      }
    `;
    return c.html(layout('Projects', content) as unknown as string);
  });

  // Project detail
  app.get('/projects/:id', async (c) => {
    const projectId = c.req.param('id');
    const project = await db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) return c.notFound();

    const projectIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.projectId, projectId))
      .orderBy(sql`${issues.createdAt} DESC`)
      .all();

    // Stats
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

    const totalCompleted = projectTasks.filter((t) => t.status === 'completed').length;
    const totalTokens = projectTasks.filter((t) => t.status === 'completed').reduce((s, t) => s + (t.tokensUsed ?? 0), 0);
    const available = projectIssues.filter((i) => i.status === 'available').length;

    const langs = JSON.parse(project.languages) as string[];

    const content = html`
      <h1>${project.githubOwner}/${project.githubRepo}</h1>
      <p style="color:#6c757d;margin-bottom:1rem">
        ${langs.map((l) => html`<span class="badge">${l}</span>`)}
        &nbsp; Registered by <strong>${project.registeredBy}</strong> on ${project.createdAt.substring(0, 10)}
      </p>
      <div class="stats-grid">
        <div class="stat-card"><div class="value">${fmtNum(totalCompleted)}</div><div class="label">Tasks Completed</div></div>
        <div class="stat-card"><div class="value">${fmtNum(Math.round(totalTokens / 1000))}K</div><div class="label">Tokens Used</div></div>
        <div class="stat-card"><div class="value">${fmtNum(available)}</div><div class="label">Available Issues</div></div>
      </div>
      <h2>Issues</h2>
      ${projectIssues.length === 0
        ? html`<p class="empty">No issues registered.</p>`
        : html`<table>
          <thead><tr><th>#</th><th>Title</th><th>Complexity</th><th>Status</th></tr></thead>
          <tbody>
            ${projectIssues.map((i) => html`<tr>
              <td>#${i.githubNumber}</td>
              <td>${i.title}</td>
              <td>${i.estimatedComplexity}</td>
              <td>${i.status}</td>
            </tr>`)}
          </tbody>
        </table>`
      }
    `;
    return c.html(layout(`${project.githubOwner}/${project.githubRepo}`, content) as unknown as string);
  });

  // Contributors list
  app.get('/contributors', async (c) => {
    const q = c.req.query('q') ?? '';
    const language = c.req.query('language') ?? '';
    const sort = c.req.query('sort') ?? 'tasks';

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

    // Only show contributors with ≥1 completed task
    allContributors = allContributors.filter((c) => statsMap.has(c.id));

    if (q) {
      const lower = q.toLowerCase();
      allContributors = allContributors.filter((c) => c.githubUsername.toLowerCase().includes(lower));
    }
    if (language) {
      allContributors = allContributors.filter((c) => {
        const langs = JSON.parse(c.languages) as string[];
        return langs.includes(language);
      });
    }

    if (sort === 'tokens') {
      allContributors.sort((a, b) => (statsMap.get(b.id)?.tokens ?? 0) - (statsMap.get(a.id)?.tokens ?? 0));
    } else {
      allContributors.sort((a, b) => (statsMap.get(b.id)?.count ?? 0) - (statsMap.get(a.id)?.count ?? 0));
    }

    const content = html`
      <h1>Contributors</h1>
      <form class="search" method="get" action="/ui/contributors">
        <input name="q" placeholder="Search username..." value="${q}" />
        <input name="language" placeholder="Language (e.g. rust)" value="${language}" />
        <select name="sort">
          <option value="tasks" ${sort === 'tasks' ? 'selected' : ''}>Sort: Tasks</option>
          <option value="tokens" ${sort === 'tokens' ? 'selected' : ''}>Sort: Tokens</option>
        </select>
        <button type="submit">Search</button>
        ${(q || language) ? html`<a href="/ui/contributors" style="padding:0.45rem 0.75rem;color:#6c757d">Clear</a>` : ''}
      </form>
      ${allContributors.length === 0
        ? html`<p class="empty">No contributors found.</p>`
        : html`<table>
          <thead><tr><th>Username</th><th>Languages</th><th>Tasks</th><th>Tokens Donated</th><th>Trust</th><th>Joined</th></tr></thead>
          <tbody>
            ${allContributors.map((c) => {
              const langs = JSON.parse(c.languages) as string[];
              const stats = statsMap.get(c.id) ?? { count: 0, tokens: 0 };
              return html`<tr>
                <td><strong>${c.githubUsername}</strong></td>
                <td>${langs.map((l) => html`<span class="badge">${l}</span>`)}</td>
                <td>${fmtNum(stats.count)}</td>
                <td>${fmtNum(stats.tokens)}</td>
                <td>${c.trustScore.toFixed(2)}</td>
                <td>${c.createdAt.substring(0, 10)}</td>
              </tr>`;
            })}
          </tbody>
        </table>`
      }
    `;
    return c.html(layout('Contributors', content) as unknown as string);
  });

  // Leaderboard
  app.get('/leaderboard', async (c) => {
    const period = (c.req.query('period') ?? 'all') as 'all' | 'month' | 'week';
    const sort = (c.req.query('sort') ?? 'tokens') as 'tokens' | 'tasks' | 'streak';

    // Reuse leaderboard logic inline
    const periodSql =
      period === 'week'
        ? sql`${tasks.createdAt} >= datetime('now', '-7 days')`
        : period === 'month'
          ? sql`${tasks.createdAt} >= datetime('now', '-30 days')`
          : null;

    const statusFilter = sql`${tasks.status} IN ('completed', 'failed')`;
    const whereClause = periodSql ? sql`(${statusFilter}) AND (${periodSql})` : statusFilter;

    const taskRows = await db
      .select({ contributorId: tasks.contributorId, status: tasks.status, tokensUsed: tasks.tokensUsed })
      .from(tasks)
      .where(whereClause)
      .all();

    const allCompletedRows = await db
      .select({ contributorId: tasks.contributorId, createdAt: tasks.createdAt })
      .from(tasks)
      .where(eq(tasks.status, 'completed'))
      .all();

    const statsMap = new Map<string, { completed: number; failed: number; totalTokens: number }>();
    for (const row of taskRows) {
      const entry = statsMap.get(row.contributorId) ?? { completed: 0, failed: 0, totalTokens: 0 };
      if (row.status === 'completed') { entry.completed++; entry.totalTokens += row.tokensUsed ?? 0; }
      else { entry.failed++; }
      statsMap.set(row.contributorId, entry);
    }

    const datesMap = new Map<string, string[]>();
    for (const row of allCompletedRows) {
      const dates = datesMap.get(row.contributorId) ?? [];
      dates.push(row.createdAt);
      datesMap.set(row.contributorId, dates);
    }

    function computeStreak(dates: string[]): number {
      if (dates.length === 0) return 0;
      const uniqueDays = [...new Set(dates.map((d) => d.substring(0, 10)))].sort().reverse();
      const today = new Date();
      const todayStr = today.toISOString().substring(0, 10);
      if (uniqueDays[0] !== todayStr) {
        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1);
        if (uniqueDays[0] !== yesterday.toISOString().substring(0, 10)) return 0;
      }
      let streak = 0;
      for (let i = 0; i < uniqueDays.length; i++) {
        const expected = new Date(today);
        expected.setDate(today.getDate() - i);
        if (uniqueDays[i] === expected.toISOString().substring(0, 10)) streak++;
        else break;
      }
      return streak;
    }

    const eligibleIds = [...statsMap.keys()].filter((id) => (statsMap.get(id)?.completed ?? 0) > 0);
    const contributorRows = await db
      .select({ id: contributors.id, githubUsername: contributors.githubUsername })
      .from(contributors)
      .all();
    const usernameMap = new Map(contributorRows.map((r) => [r.id, r.githubUsername]));

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

    if (sort === 'tokens') entries.sort((a, b) => b.totalTokensDonated - a.totalTokensDonated);
    else if (sort === 'tasks') entries.sort((a, b) => b.tasksCompleted - a.tasksCompleted);
    else entries.sort((a, b) => b.currentStreak - a.currentStreak);
    entries = entries.slice(0, 100).map((e, i) => ({ ...e, rank: i + 1 }));

    function rankClass(rank: number) {
      return rank === 1 ? 'rank rank-1' : rank === 2 ? 'rank rank-2' : rank === 3 ? 'rank rank-3' : 'rank';
    }

    const makeTabUrl = (p: string, s: string) => `/ui/leaderboard?period=${p}&sort=${s}`;

    const content = html`
      <h1>Leaderboard</h1>
      <div style="display:flex;gap:1rem;align-items:center;flex-wrap:wrap;margin-bottom:1rem">
        <div>
          <span style="font-size:0.85rem;color:#6c757d;margin-right:0.5rem">Period:</span>
          <div class="period-tabs" style="display:inline-flex">
            <a href="${makeTabUrl('all', sort)}" class="${period === 'all' ? 'active' : ''}">All time</a>
            <a href="${makeTabUrl('month', sort)}" class="${period === 'month' ? 'active' : ''}">Month</a>
            <a href="${makeTabUrl('week', sort)}" class="${period === 'week' ? 'active' : ''}">Week</a>
          </div>
        </div>
        <div>
          <span style="font-size:0.85rem;color:#6c757d;margin-right:0.5rem">Sort:</span>
          <div class="period-tabs" style="display:inline-flex">
            <a href="${makeTabUrl(period, 'tokens')}" class="${sort === 'tokens' ? 'active' : ''}">Tokens</a>
            <a href="${makeTabUrl(period, 'tasks')}" class="${sort === 'tasks' ? 'active' : ''}">Tasks</a>
            <a href="${makeTabUrl(period, 'streak')}" class="${sort === 'streak' ? 'active' : ''}">Streak</a>
          </div>
        </div>
      </div>
      ${entries.length === 0
        ? html`<p class="empty">No data for this period yet.</p>`
        : html`<table>
          <thead><tr><th>#</th><th>Contributor</th><th>Tasks</th><th>Tokens Donated</th><th>Success Rate</th><th>Streak</th></tr></thead>
          <tbody>
            ${entries.map((e) => html`<tr>
              <td><span class="${rankClass(e.rank)}">${e.rank}</span></td>
              <td>${e.githubUsername}</td>
              <td>${fmtNum(e.tasksCompleted)}</td>
              <td>${fmtNum(e.totalTokensDonated)}</td>
              <td>${fmtPct(e.successRate)}</td>
              <td>${e.currentStreak > 0 ? `${e.currentStreak}d` : '—'}</td>
            </tr>`)}
          </tbody>
        </table>`
      }
    `;
    return c.html(layout('Leaderboard', content) as unknown as string);
  });

  return app;
}
