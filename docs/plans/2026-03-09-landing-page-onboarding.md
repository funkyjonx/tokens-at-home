# Landing Page & Contributor Onboarding Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a public landing page at `GET /` and a contributor onboarding guide at `GET /ui/onboarding` to the coordinator.

**Architecture:** Both pages are server-rendered HTML using Hono's `html` tagged template, added to `packages/coordinator/src/routes/ui.ts`. The landing page serves the root `/` route directly on the main app (not under `/ui`). Live stats are fetched from the DB at request time. The nav gets a "Home" link across all existing pages.

**Tech Stack:** Hono, hono/html, Drizzle ORM, TypeScript, better-sqlite3

---

### Task 1: Add landing page route at `GET /`

**Files:**
- Modify: `packages/coordinator/src/routes/ui.ts`
- Modify: `packages/coordinator/src/index.ts`

**Context:**
- `ui.ts` exports `uiRoutes(db)` which is mounted at `/ui`
- The root `GET /` currently returns 404 from the main app in `index.ts`
- The `layout()` function in `ui.ts` generates the shared nav/footer HTML
- Live stats already exist in the `/ui` dashboard handler — reuse the same DB queries
- The GitHub App install URL is `https://github.com/apps/tokens-at-home`
- npm install command: `npm install -g @tah/cli` (adjust if package name differs)

**Step 1: Export a `landingRoute` function from `ui.ts`**

Add this at the bottom of `packages/coordinator/src/routes/ui.ts`, after all existing route handlers but before the closing brace of `uiRoutes`:

```ts
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
        <p style="font-size:1.15rem; color:#6c757d; max-width:560px; margin:0 auto 2rem;">
          Open-source projects get free AI contributions. Contributors donate their Claude tokens to fix real issues.
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
          <ol style="padding-left:1.25rem; line-height:2;">
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
          <ol style="padding-left:1.25rem; line-height:2;">
            <li>Install Claude Code &amp; the tah CLI</li>
            <li>Run <code>tah start</code></li>
            <li>Claude works on issues while you sleep</li>
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
```

**Step 2: Mount it in `index.ts`**

In `packages/coordinator/src/index.ts`, add the import:
```ts
import { uiRoutes, landingRoute } from './routes/ui.js';
```

Then after the existing `app.route('/ui', uiRoutes(db));` line, add:
```ts
app.route('/', landingRoute(db));
```

**Step 3: Build and verify**

```bash
pnpm --filter coordinator build
```
Expected: Build success with no TypeScript errors.

Then start the coordinator locally and visit `http://localhost:3000`:
```bash
node packages/coordinator/dist/index.js
```

**Step 4: Commit**

```bash
git add packages/coordinator/src/routes/ui.ts packages/coordinator/src/index.ts
git commit -m "feat(ui): add landing page at GET /"
```

---

### Task 2: Add contributor onboarding page at `GET /ui/onboarding`

**Files:**
- Modify: `packages/coordinator/src/routes/ui.ts`

**Context:**
- All `ui` routes are registered inside the `uiRoutes(db)` function
- The `layout()` function wraps content with nav and footer
- The nav currently has: Dashboard, Projects, Contributors, Leaderboard
- npm package name: check `packages/cli/package.json` for the published name
- The coordinator URL for production is `https://tokens-at-home.fly.dev` (or `https://tokensathome.dev` once DNS is set up)

**Step 1: Check the CLI package name**

```bash
cat packages/cli/package.json | grep '"name"'
```

Note the name — it's what users will `npm install -g`.

**Step 2: Add the onboarding route inside `uiRoutes`**

Inside the `uiRoutes(db)` function in `ui.ts`, add this route after the existing leaderboard route but before the `return app;` line:

```ts
app.get('/onboarding', (c) => {
  const content = html`
    <h1>Contributor Onboarding</h1>
    <p style="color:#6c757d; margin-bottom:2rem;">
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
      <pre style="background:#f1f3f5; padding:0.75rem 1rem; border-radius:6px; overflow-x:auto;"><code>npm install -g @tah/cli</code></pre>
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
      <pre style="background:#f1f3f5; padding:0.75rem 1rem; border-radius:6px; overflow-x:auto;"><code>tah contributor register</code></pre>
      <p style="margin-top:0.75rem; color:#6c757d; font-size:0.9rem;">
        This links your GitHub username to your contributor account and generates an auth token stored in <code>~/.tah/config.json</code>.
      </p>
    </div>

    <div class="card">
      <h2 style="margin-top:0;">Step 5: Start contributing</h2>
      <p>Run the worker. It will poll for available issues, clone repos, invoke Claude, and submit PRs automatically.</p>
      <pre style="background:#f1f3f5; padding:0.75rem 1rem; border-radius:6px; overflow-x:auto;"><code>tah start</code></pre>
      <p style="margin-top:0.75rem; color:#6c757d; font-size:0.9rem;">
        Leave it running in the background. Use <code>Ctrl+C</code> to stop gracefully.
      </p>
    </div>

    <div class="card">
      <h2 style="margin-top:0;">Optional: Pin projects you care about</h2>
      <p>By default the worker picks up any available issue. You can pin specific projects to prioritize them.</p>
      <pre style="background:#f1f3f5; padding:0.75rem 1rem; border-radius:6px; overflow-x:auto;"><code>tah project pin owner/repo</code></pre>
    </div>

    <div style="text-align:center; padding:1.5rem 0;">
      <a href="/ui/leaderboard" style="color:#0d6efd;">See the leaderboard →</a>
    </div>
  `;
  return c.html(String(layout('Contributor Onboarding', content)));
});
```

**Step 3: Build and verify**

```bash
pnpm --filter coordinator build
```
Expected: Build success.

Visit `http://localhost:3000/ui/onboarding` and verify all 5 steps render correctly.

**Step 4: Commit**

```bash
git add packages/coordinator/src/routes/ui.ts
git commit -m "feat(ui): add contributor onboarding guide at /ui/onboarding"
```

---

### Task 3: Update nav to include Home link and Onboarding link

**Files:**
- Modify: `packages/coordinator/src/routes/ui.ts`

**Context:**
- The `layout()` function at the top of `ui.ts` contains the nav HTML (lines ~57–63)
- Current nav links: Dashboard (`/ui`), Projects (`/ui/projects`), Contributors (`/ui/contributors`), Leaderboard (`/ui/leaderboard`)
- Add: Home (`/`) and Get Started (`/ui/onboarding`)

**Step 1: Update the nav in `layout()`**

Find this block in `layout()`:
```ts
  <nav>
    <span class="brand">Tokens at Home</span>
    <a href="/ui">Dashboard</a>
    <a href="/ui/projects">Projects</a>
    <a href="/ui/contributors">Contributors</a>
    <a href="/ui/leaderboard">Leaderboard</a>
  </nav>
```

Replace with:
```ts
  <nav>
    <a href="/" class="brand" style="text-decoration:none;">Tokens at Home</a>
    <a href="/ui">Dashboard</a>
    <a href="/ui/projects">Projects</a>
    <a href="/ui/contributors">Contributors</a>
    <a href="/ui/leaderboard">Leaderboard</a>
    <a href="/ui/onboarding" style="margin-left:auto;">Get Started</a>
  </nav>
```

**Step 2: Build, verify nav appears on all pages**

```bash
pnpm --filter coordinator build
```

Visit `/`, `/ui`, `/ui/projects`, `/ui/leaderboard` — all should show the updated nav.

**Step 3: Commit**

```bash
git add packages/coordinator/src/routes/ui.ts
git commit -m "feat(ui): update nav with Home link and Get Started"
```

---

### Task 4: Full test run and deploy

**Files:** none

**Step 1: Run full test suite**

```bash
pnpm test
```
Expected: All tests pass (the landing page and onboarding are HTML routes with no new DB queries that need testing — the existing dashboard tests cover the shared query patterns).

**Step 2: Push and deploy**

```bash
git push
fly deploy
```

**Step 3: Verify in production**

- Visit `https://tokens-at-home.fly.dev/` — landing page loads with live stats
- Visit `https://tokens-at-home.fly.dev/ui/onboarding` — onboarding guide renders
- Nav "Home" link works from dashboard pages
- "Add your project" button links to GitHub App install page
- "Start contributing" / "Get started" link goes to onboarding
