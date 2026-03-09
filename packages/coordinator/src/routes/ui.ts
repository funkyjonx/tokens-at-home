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
    :root {
      --bg: #070d1a;
      --bg-card: #0d1629;
      --bg-hover: #111e38;
      --border: #1e3057;
      --border-glow: #1e4a8a;
      --accent: #38b6ff;
      --accent-dim: #1a6fa8;
      --accent-glow: rgba(56, 182, 255, 0.15);
      --text: #e8f0fe;
      --text-muted: #6b8cba;
      --text-dim: #3d5a8a;
      --green: #22c55e;
      --gold: #f59e0b;
      --silver: #94a3b8;
      --bronze: #c47c3c;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { color: #fff; text-decoration: none; }
    nav {
      background: rgba(7, 13, 26, 0.9);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
      padding: 0.75rem 1.5rem;
      display: flex; align-items: center; gap: 1.5rem;
      position: sticky; top: 0; z-index: 100;
    }
    nav .brand { color: #fff; font-weight: 700; font-size: 1.1rem; letter-spacing: -0.02em; }
    nav a { color: var(--text-muted); font-size: 0.9rem; transition: color 0.15s; }
    nav a:hover { color: var(--text); }
    .container { max-width: 960px; margin: 2rem auto; padding: 0 1.25rem; }
    h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 1rem; color: #fff; letter-spacing: -0.02em; }
    h2 { font-size: 1.15rem; font-weight: 600; margin: 1.5rem 0 0.75rem; color: #fff; }
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1.25rem;
      margin-bottom: 1rem;
      transition: border-color 0.2s;
    }
    .card:hover { border-color: var(--border-glow); }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
    .stat-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1.25rem;
      text-align: center;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .stat-card:hover { border-color: var(--accent); box-shadow: 0 0 20px var(--accent-glow); }
    .stat-card .value { font-size: 2rem; font-weight: 700; color: var(--accent); letter-spacing: -0.03em; }
    .stat-card .label { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem; text-transform: uppercase; letter-spacing: 0.05em; }
    table { width: 100%; border-collapse: collapse; background: var(--bg-card); border-radius: 10px; overflow: hidden; border: 1px solid var(--border); }
    th { background: rgba(30, 48, 87, 0.4); padding: 0.75rem 1rem; text-align: left; font-size: 0.8rem; color: var(--text-muted); border-bottom: 1px solid var(--border); text-transform: uppercase; letter-spacing: 0.05em; }
    td { padding: 0.75rem 1rem; border-bottom: 1px solid rgba(30, 48, 87, 0.4); font-size: 0.9rem; color: var(--text); }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: var(--bg-hover); }
    .badge { display: inline-block; padding: 0.2em 0.6em; border-radius: 4px; font-size: 0.75rem; background: rgba(56, 182, 255, 0.1); color: var(--accent); border: 1px solid rgba(56, 182, 255, 0.2); margin: 0.1em; }
    form.search { display: flex; gap: 0.5rem; margin-bottom: 1.25rem; flex-wrap: wrap; }
    form.search input, form.search select {
      padding: 0.45rem 0.75rem;
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 0.9rem;
      background: var(--bg-card);
      color: var(--text);
    }
    form.search input:focus, form.search select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-glow); }
    form.search button { padding: 0.45rem 1rem; background: var(--accent); color: #000; border: none; border-radius: 6px; cursor: pointer; font-size: 0.9rem; font-weight: 600; transition: background 0.15s; }
    form.search button:hover { background: #60cbff; }
    .empty { color: var(--text-muted); padding: 2rem; text-align: center; }
    .rank { font-weight: 700; color: var(--text-muted); }
    .rank-1 { color: var(--gold); }
    .rank-2 { color: var(--silver); }
    .rank-3 { color: var(--bronze); }
    .period-tabs { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
    .period-tabs a { padding: 0.35rem 0.8rem; border-radius: 6px; font-size: 0.85rem; color: var(--text-muted); background: var(--bg-card); border: 1px solid var(--border); transition: all 0.15s; }
    .period-tabs a:hover { color: var(--text); border-color: var(--border-glow); }
    .period-tabs a.active { background: var(--accent); color: #000; border-color: var(--accent); font-weight: 600; }
    code { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.875em; background: rgba(56, 182, 255, 0.08); color: var(--accent); padding: 0.15em 0.4em; border-radius: 4px; border: 1px solid rgba(56, 182, 255, 0.15); }
    pre { background: #050c18; border: 1px solid var(--border); border-radius: 8px; padding: 0.9rem 1.1rem; overflow-x: auto; }
    pre code { background: none; border: none; padding: 0; color: var(--accent); font-size: 0.9rem; }
    footer { text-align: center; padding: 2rem; color: var(--text-dim); font-size: 0.85rem; border-top: 1px solid var(--border); margin-top: 3rem; }
    footer a { color: var(--text-muted); }
    footer a:hover { color: var(--text); }
  </style>
</head>
<body>
  <nav>
    <a href="/" class="brand" style="text-decoration:none;">Tokens at Home</a>
    <a href="/ui">Dashboard</a>
    <a href="/ui/projects">Projects</a>
    <a href="/ui/contributors">Contributors</a>
    <a href="/ui/leaderboard">Leaderboard</a>
    <a href="/ui/onboarding" style="margin-left:auto;">Get Started</a>
  </nav>
  <div class="container">
    ${content}
  </div>
  <footer>
    <a href="https://github.com/funkyjonx/tokens-at-home" target="_blank">GitHub</a>
    &nbsp;·&nbsp;
    <a href="/ui">Dashboard</a>
    &nbsp;·&nbsp;
    <a href="/ui/onboarding">Get Started</a>
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

    const inProgressTasks = await db.select({
      id: tasks.id, status: tasks.status, phaseStartedAt: tasks.phaseStartedAt,
      githubUsername: contributors.githubUsername,
      issueTitle: issues.title, githubNumber: issues.githubNumber,
      githubOwner: projects.githubOwner, githubRepo: projects.githubRepo,
    }).from(tasks)
      .innerJoin(contributors, eq(tasks.contributorId, contributors.id))
      .innerJoin(issues, eq(tasks.issueId, issues.id))
      .innerJoin(projects, eq(issues.projectId, projects.id))
      .where(sql`${tasks.status} NOT IN ('completed', 'failed')`)
      .orderBy(sql`${tasks.updatedAt} DESC`)
      .limit(5)
      .all();

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
      ${inProgressTasks.length > 0 ? html`
        <h2>🔴 Live</h2>
        <table>
          <thead><tr><th>Contributor</th><th>Project</th><th>Issue</th><th>Phase</th></tr></thead>
          <tbody>
            ${inProgressTasks.map((t) => html`<tr>
              <td><a href="/ui/contributors/${t.githubUsername}">@${t.githubUsername}</a></td>
              <td>${t.githubOwner}/${t.githubRepo}</td>
              <td>#${t.githubNumber} ${t.issueTitle}</td>
              <td>${t.status}</td>
            </tr>`)}
          </tbody>
        </table>
      ` : ''}
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

  // Contributor profile
  app.get('/contributors/:username', async (c) => {
    const { username } = c.req.param();
    const contributor = await db.select().from(contributors)
      .where(eq(contributors.githubUsername, username)).get();
    if (!contributor) return c.notFound();

    const allTasks = await db.select({
      status: tasks.status, tokensUsed: tasks.tokensUsed, createdAt: tasks.createdAt,
      prUrl: tasks.prUrl, issueId: tasks.issueId,
    }).from(tasks).where(eq(tasks.contributorId, contributor.id)).all();

    const completed = allTasks.filter((t) => t.status === 'completed');
    const totalTokens = completed.reduce((s, t) => s + (t.tokensUsed ?? 0), 0);
    const terminal = allTasks.filter((t) => ['completed', 'failed'].includes(t.status));
    const successRate = terminal.length > 0 ? completed.length / terminal.length : 0;

    const langs = JSON.parse(contributor.languages) as string[];
    const githubProfileUrl = `https://github.com/${contributor.githubUsername}`;

    const content = html`
      <div class="card" style="display:flex;align-items:center;gap:1.5rem;margin-bottom:1.5rem">
        <img src="https://github.com/${contributor.githubUsername}.png?size=80"
             style="width:80px;height:80px;border-radius:50%;border:2px solid #dee2e6" />
        <div>
          <h1 style="margin-bottom:0.25rem">
            <a href="${githubProfileUrl}" target="_blank" style="color:#212529">
              @${contributor.githubUsername}
            </a>
          </h1>
          <div style="color:#6c757d;font-size:0.9rem">
            Contributing since ${contributor.createdAt.substring(0, 10)}
            &nbsp;·&nbsp;
            ${langs.map((l) => html`<span class="badge">${l}</span>`)}
          </div>
        </div>
      </div>
      <div class="stats-grid">
        <div class="stat-card"><div class="value">${fmtNum(completed.length)}</div><div class="label">Tasks Completed</div></div>
        <div class="stat-card"><div class="value">${fmtNum(Math.round(totalTokens / 1000))}K</div><div class="label">Tokens Donated</div></div>
        <div class="stat-card"><div class="value">${fmtPct(successRate)}</div><div class="label">Success Rate</div></div>
      </div>
      <h2>Recent Contributions</h2>
      ${completed.length === 0
        ? html`<p class="empty">No completed tasks yet.</p>`
        : html`<table>
          <thead><tr><th>Issue</th><th>Tokens</th><th>Date</th><th>PR</th></tr></thead>
          <tbody>
            ${completed.slice(0, 20).map((t) => html`<tr>
              <td>${t.issueId}</td>
              <td>${fmtNum(t.tokensUsed ?? 0)}</td>
              <td>${t.createdAt.substring(0, 10)}</td>
              <td>${t.prUrl ? html`<a href="${t.prUrl}" target="_blank">View PR</a>` : '—'}</td>
            </tr>`)}
          </tbody>
        </table>`
      }
    `;

    return c.html(layout(`@${contributor.githubUsername}`, content) as unknown as string);
  });

  app.get('/onboarding', (c) => {
    const content = html`
      <h1>Contributor Onboarding</h1>
      <p style="color:var(--text-muted); margin-bottom:2rem;">
        Follow these steps to start donating your Claude tokens to open-source projects.
      </p>

      <div class="card">
        <h2 style="margin-top:0;">Step 1: Install Claude Code</h2>
        <p>Claude Code is the AI coding assistant that does the actual work. You need a Claude account with API access.</p>
        <ol style="padding-left:1.25rem; line-height:2; margin-top:0.75rem;">
          <li>Sign up at <a href="https://claude.ai" target="_blank">claude.ai</a> and add API credits</li>
          <li>Install Claude Code: <code>npm install -g @anthropic-ai/claude-code</code></li>
          <li>Authenticate: <code>claude login</code></li>
        </ol>
      </div>

      <div class="card">
        <h2 style="margin-top:0;">Step 2: Install the tah CLI</h2>
        <p>The <code>tah</code> CLI connects your machine to the coordinator and manages the worker loop.</p>
        <pre><code>npm install -g @tah/cli</code></pre>
      </div>

      <div class="card">
        <h2 style="margin-top:0;">Step 3: Install the GitHub CLI</h2>
        <p>The worker uses <code>gh</code> to create pull requests on your behalf.</p>
        <ol style="padding-left:1.25rem; line-height:2; margin-top:0.75rem;">
          <li>Install from <a href="https://cli.github.com" target="_blank">cli.github.com</a></li>
          <li>Authenticate: <code>gh auth login</code></li>
        </ol>
      </div>

      <div class="card">
        <h2 style="margin-top:0;">Step 4: Register as a contributor</h2>
        <p>Create your contributor profile on the coordinator.</p>
        <pre><code>tah contributor register</code></pre>
        <p style="margin-top:0.75rem; color:var(--text-muted); font-size:0.9rem;">
          This links your GitHub username to your contributor account and generates an auth token stored in <code>~/.tah/config.json</code>.
        </p>
      </div>

      <div class="card">
        <h2 style="margin-top:0;">Step 5: Start contributing</h2>
        <p>Run the worker. It will poll for available issues, clone repos, invoke Claude, and submit PRs automatically.</p>
        <pre><code>tah start</code></pre>
        <p style="margin-top:0.75rem; color:var(--text-muted); font-size:0.9rem;">
          Leave it running in the background. Use <code>Ctrl+C</code> to stop gracefully.
        </p>
      </div>

      <div class="card">
        <h2 style="margin-top:0;">Optional: Pin projects you care about</h2>
        <p>By default the worker picks up any available issue. You can pin specific projects to prioritize them.</p>
        <pre><code>tah project pin owner/repo</code></pre>
      </div>

      <div style="text-align:center; padding:1.5rem 0;">
        <a href="/ui/leaderboard">See the leaderboard →</a>
      </div>
    `;
    return c.html(String(layout('Contributor Onboarding', content)));
  });

  return app;
}

export function landingRoute(db: Db) {
  const app = new Hono();

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

    const topContributors = await db
      .select({
        githubUsername: contributors.githubUsername,
        tokensUsed: sql<number>`sum(coalesce(${tasks.tokensUsed}, 0))`,
        tasksCompleted: sql<number>`count(${tasks.id})`,
      })
      .from(contributors)
      .leftJoin(tasks, sql`${tasks.contributorId} = ${contributors.id} AND ${tasks.status} = 'completed'`)
      .groupBy(contributors.id)
      .orderBy(sql`sum(coalesce(${tasks.tokensUsed}, 0)) desc`)
      .limit(5)
      .all();

    const content = html`
      <div style="text-align:center; padding: 3rem 1rem 2rem;">
        <h1 style="font-size:2.5rem; margin-bottom:0.5rem;">Tokens at Home</h1>
        <p style="font-size:1.2rem; color:#212529; max-width:600px; margin:0 auto 0.75rem; font-weight:500;">
          Put your surplus Claude tokens to work for open source.
        </p>
        <p style="font-size:1rem; color:#6c757d; max-width:580px; margin:0 auto 2rem; line-height:1.7;">
          Every Claude subscription comes with tokens you may not fully use. Tokens at Home lets you allocate those
          surplus tokens to open-source projects you care about — and Claude does the work: cloning repos, fixing
          issues, and opening pull requests, automatically.
        </p>
        <div style="display:flex; gap:1rem; justify-content:center; flex-wrap:wrap;">
          <a href="https://github.com/apps/tokens-at-home" target="_blank"
             style="padding:0.65rem 1.5rem; background:#0d6efd; color:#fff; border-radius:8px; font-size:1rem; font-weight:600;">
            Add your project
          </a>
          <a href="/ui/onboarding"
             style="padding:0.65rem 1.5rem; background:#e9ecef; color:#212529; border-radius:8px; font-size:1rem; font-weight:600;">
            Start contributing
          </a>
        </div>
      </div>

      <div class="stats-grid" style="max-width:700px; margin:0 auto 2.5rem;">
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
          <div class="label">PRs Submitted</div>
        </div>
        <div class="stat-card">
          <div class="value">${fmtNum(Math.round((taskStats?.tokens ?? 0) / 1000))}K</div>
          <div class="label">Tokens Donated</div>
        </div>
      </div>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:1.5rem; max-width:800px; margin:0 auto 2.5rem;">
        <div class="card">
          <h2 style="margin-top:0;">For project owners</h2>
          <p style="color:#6c757d; font-size:0.9rem; margin-bottom:0.75rem;">
            Get AI-generated pull requests on your issues — at zero cost to you.
          </p>
          <ol style="padding-left:1.25rem; line-height:2; margin-top:0.75rem;">
            <li>Install the GitHub App on your repo</li>
            <li>Label issues with <code>tah</code></li>
            <li>Receive pull requests automatically</li>
          </ol>
          <a href="https://github.com/apps/tokens-at-home" target="_blank"
             style="display:inline-block; margin-top:1rem; padding:0.45rem 1rem; background:#0d6efd; color:#fff; border-radius:6px; font-size:0.9rem;">
            Install App →
          </a>
        </div>
        <div class="card">
          <h2 style="margin-top:0;">For contributors</h2>
          <p style="color:#6c757d; font-size:0.9rem; margin-bottom:0.75rem;">
            Pin the projects you care about and allocate your surplus tokens to them each cycle.
          </p>
          <ol style="padding-left:1.25rem; line-height:2; margin-top:0.75rem;">
            <li>Install Claude Code &amp; the tah CLI</li>
            <li>Pin projects you want to support</li>
            <li>Run <code>tah start</code> — Claude does the rest</li>
          </ol>
          <a href="/ui/onboarding"
             style="display:inline-block; margin-top:1rem; padding:0.45rem 1rem; background:#198754; color:#fff; border-radius:6px; font-size:0.9rem;">
            Get started →
          </a>
        </div>
      </div>

      ${topContributors.some((c) => (c.tokensUsed ?? 0) > 0) ? html`
        <div style="max-width:600px; margin:0 auto;">
          <h2 style="text-align:center; margin-bottom:1rem;">Top Contributors</h2>
          <table>
            <thead><tr><th>#</th><th>Contributor</th><th>Tokens Donated</th><th>PRs</th></tr></thead>
            <tbody>
              ${topContributors.map((c, i) => html`<tr>
                <td class="rank rank-${i + 1}">${i + 1}</td>
                <td>@${c.githubUsername}</td>
                <td>${fmtNum(c.tokensUsed ?? 0)}</td>
                <td>${fmtNum(c.tasksCompleted ?? 0)}</td>
              </tr>`)}
            </tbody>
          </table>
          <p style="text-align:center; margin-top:0.75rem;">
            <a href="/ui/leaderboard">Full leaderboard →</a>
          </p>
        </div>
      ` : ''}
    `;

    return c.html(String(layout('Home', content)));
  });

  return app;
}
