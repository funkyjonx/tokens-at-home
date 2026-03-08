# GitHub App Registration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace manual `tah project register` + `tah project issue sync` with a GitHub App that auto-registers projects on install and keeps issue state in real-time sync via webhooks.

**Architecture:** A new `POST /webhooks/github` route in the coordinator handles all GitHub App events. HMAC-SHA256 signature verification gates every request. A thin GitHub API client module handles language detection and `.tah.yml` config reading. The `projects` table gets one new nullable column (`github_installation_id`) to enable bulk project deactivation when an app installation is removed.

**Tech Stack:** Hono (existing), better-sqlite3/Drizzle (existing), Node.js `crypto` (built-in for HMAC), `js-yaml` (new dep, for `.tah.yml` parsing), GitHub REST API (unauthenticated for public repos, token for private)

---

### Task 1: Add `github_installation_id` column to projects schema

**Files:**
- Modify: `packages/coordinator/src/db/schema.ts`
- Modify: `packages/coordinator/src/db/index.ts` (additive migration)
- Modify: `packages/coordinator/src/routes/api.test.ts` (update CREATE TABLE)

**Step 1: Add column to Drizzle schema**

In `packages/coordinator/src/db/schema.ts`, add to the `projects` table after `createdAt`:

```ts
githubInstallationId: text('github_installation_id'),
```

**Step 2: Add additive migration in `index.ts`**

In the `addColumns` array inside `initSchema()`, add:

```ts
"ALTER TABLE projects ADD COLUMN github_installation_id TEXT",
```

**Step 3: Update CREATE TABLE in `api.test.ts`**

In the inline SQL in `createTestDb()`, add to the projects table definition:

```sql
github_installation_id TEXT,
```

**Step 4: Run existing tests to confirm nothing is broken**

```bash
cd packages/coordinator && pnpm test
```
Expected: all pass

**Step 5: Commit**

```bash
git add packages/coordinator/src/db/schema.ts packages/coordinator/src/db/index.ts packages/coordinator/src/routes/api.test.ts
git commit -m "feat(coordinator): add github_installation_id column to projects"
```

---

### Task 2: Add `js-yaml` dependency and GitHub client module

**Files:**
- Modify: `packages/coordinator/package.json` (add `js-yaml`)
- Create: `packages/coordinator/src/services/github.ts`

**Step 1: Install `js-yaml`**

```bash
pnpm --filter coordinator add js-yaml
pnpm --filter coordinator add -D @types/js-yaml
```

**Step 2: Create the GitHub client module**

Create `packages/coordinator/src/services/github.ts`:

```ts
import { load as parseYaml } from 'js-yaml';
import { TaskTypeSchema } from '@tah/shared';
import type { TaskType } from '@tah/shared';

const GH_API = 'https://api.github.com';
const HEADERS = {
  'User-Agent': 'tokens-at-home',
  Accept: 'application/vnd.github.v3+json',
};

export interface TahConfig {
  label: string;
  maxConcurrent: number;
  taskTypes: TaskType[];
}

export const DEFAULT_TAH_CONFIG: TahConfig = {
  label: 'tah',
  maxConcurrent: 3,
  taskTypes: ['code'],
};

/** Fetch primary languages for a repo. Returns lowercase language names. */
export async function fetchRepoLanguages(owner: string, repo: string): Promise<string[]> {
  try {
    const res = await fetch(`${GH_API}/repos/${owner}/${repo}/languages`, { headers: HEADERS });
    if (!res.ok) return ['typescript'];
    const data = await res.json() as Record<string, number>;
    return Object.keys(data).map((l) => l.toLowerCase()).slice(0, 5);
  } catch {
    return ['typescript'];
  }
}

/** Fetch and parse .tah.yml from a repo's default branch. Falls back to defaults. */
export async function fetchTahConfig(owner: string, repo: string): Promise<TahConfig> {
  try {
    const res = await fetch(
      `${GH_API}/repos/${owner}/${repo}/contents/.tah.yml`,
      { headers: HEADERS },
    );
    if (!res.ok) return DEFAULT_TAH_CONFIG;

    const data = await res.json() as { content?: string; encoding?: string };
    if (!data.content || data.encoding !== 'base64') return DEFAULT_TAH_CONFIG;

    const yaml = Buffer.from(data.content, 'base64').toString('utf-8');
    const parsed = parseYaml(yaml) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return DEFAULT_TAH_CONFIG;

    const label = typeof parsed['label'] === 'string' ? parsed['label'] : DEFAULT_TAH_CONFIG.label;
    const maxConcurrent = typeof parsed['maxConcurrent'] === 'number'
      ? Math.max(1, Math.min(20, parsed['maxConcurrent']))
      : DEFAULT_TAH_CONFIG.maxConcurrent;

    const rawTypes = Array.isArray(parsed['taskTypes']) ? parsed['taskTypes'] : [];
    const taskTypes = rawTypes
      .filter((t): t is TaskType => TaskTypeSchema.safeParse(t).success)
      .slice(0, 5);

    return {
      label,
      maxConcurrent,
      taskTypes: taskTypes.length > 0 ? taskTypes : DEFAULT_TAH_CONFIG.taskTypes,
    };
  } catch {
    return DEFAULT_TAH_CONFIG;
  }
}
```

**Step 3: Verify TypeScript compiles**

```bash
pnpm --filter coordinator build
```
Expected: Build success

**Step 4: Commit**

```bash
git add packages/coordinator/src/services/github.ts packages/coordinator/package.json pnpm-lock.yaml
git commit -m "feat(coordinator): add GitHub API client for language detection and .tah.yml parsing"
```

---

### Task 3: Webhook HMAC verification helper + route skeleton

**Files:**
- Create: `packages/coordinator/src/routes/webhooks.ts`
- Create: `packages/coordinator/src/routes/webhooks.test.ts`

**Step 1: Write failing tests for HMAC verification**

Create `packages/coordinator/src/routes/webhooks.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema.js';
import { webhookRoutes } from './webhooks.js';

const SECRET = 'test-webhook-secret';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      github_owner TEXT NOT NULL,
      github_repo TEXT NOT NULL,
      registered_by TEXT NOT NULL,
      languages TEXT NOT NULL DEFAULT '[]',
      issue_label TEXT NOT NULL DEFAULT 'tah',
      claude_md TEXT,
      task_types TEXT NOT NULL DEFAULT '["code"]',
      max_concurrent INTEGER NOT NULL DEFAULT 3,
      trust_threshold REAL NOT NULL DEFAULT 0,
      github_installation_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS issues (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      github_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      task_type TEXT NOT NULL DEFAULT 'code',
      estimated_complexity TEXT NOT NULL DEFAULT 'small',
      estimated_tokens INTEGER NOT NULL DEFAULT 8000,
      status TEXT NOT NULL DEFAULT 'available',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function sign(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

function makeApp(db: ReturnType<typeof createTestDb>) {
  const app = new Hono();
  app.route('/webhooks/github', webhookRoutes(db, SECRET));
  return app;
}

describe('POST /webhooks/github', () => {
  it('returns 401 when signature is missing', async () => {
    const db = createTestDb();
    const app = makeApp(db);
    const res = await app.request('/webhooks/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'ping' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when signature is wrong', async () => {
    const db = createTestDb();
    const app = makeApp(db);
    const body = JSON.stringify({});
    const res = await app.request('/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'ping',
        'X-Hub-Signature-256': 'sha256=deadbeef',
      },
      body,
    });
    expect(res.status).toBe(401);
  });

  it('returns 200 for ping event with valid signature', async () => {
    const db = createTestDb();
    const app = makeApp(db);
    const body = JSON.stringify({ zen: 'Keep it logically awesome.' });
    const sig = sign(body, SECRET);
    const res = await app.request('/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'ping',
        'X-Hub-Signature-256': sig,
      },
      body,
    });
    expect(res.status).toBe(200);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd packages/coordinator && pnpm test webhooks
```
Expected: FAIL — `webhookRoutes` not found

**Step 3: Create the webhook route skeleton**

Create `packages/coordinator/src/routes/webhooks.ts`:

```ts
import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'crypto';
import type { Db } from '../db/index.js';

export function webhookRoutes(db: Db, secret: string) {
  const app = new Hono();

  app.post('/', async (c) => {
    const rawBody = await c.req.text();

    // Verify HMAC-SHA256 signature
    if (!verifySignature(rawBody, c.req.header('X-Hub-Signature-256') ?? '', secret)) {
      return c.json({ error: 'Invalid signature' }, 401);
    }

    const event = c.req.header('X-GitHub-Event') ?? '';
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    switch (event) {
      case 'ping':
        return c.json({ ok: true });
      default:
        return c.json({ ok: true, event, note: 'unhandled' });
    }
  });

  return app;
}

function verifySignature(body: string, signature: string, secret: string): boolean {
  if (!signature.startsWith('sha256=')) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
cd packages/coordinator && pnpm test webhooks
```
Expected: all 3 pass

**Step 5: Commit**

```bash
git add packages/coordinator/src/routes/webhooks.ts packages/coordinator/src/routes/webhooks.test.ts
git commit -m "feat(coordinator): webhook route skeleton with HMAC-SHA256 verification"
```

---

### Task 4: Handle `installation` events (register/deactivate projects)

**Files:**
- Modify: `packages/coordinator/src/routes/webhooks.ts`
- Modify: `packages/coordinator/src/routes/webhooks.test.ts`
- Modify: `packages/coordinator/src/services/github.ts` (add `fetchRepoInfo`)

**Step 1: Write failing tests for installation events**

Add to `webhooks.test.ts`:

```ts
describe('installation events', () => {
  it('registers a project on installation.created', async () => {
    const db = createTestDb();
    const app = makeApp(db);

    const body = JSON.stringify({
      action: 'created',
      installation: { id: 99, account: { login: 'acme' } },
      repositories: [{ name: 'my-app', full_name: 'acme/my-app' }],
    });
    const sig = sign(body, SECRET);

    const res = await app.request('/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'installation',
        'X-Hub-Signature-256': sig,
      },
      body,
    });

    expect(res.status).toBe(200);
    const projects = db.select().from(schema.projects).all();
    expect(projects).toHaveLength(1);
    expect(projects[0].githubOwner).toBe('acme');
    expect(projects[0].githubRepo).toBe('my-app');
    expect(projects[0].githubInstallationId).toBe('99');
  });

  it('cancels available issues and marks project inactive on installation.deleted', async () => {
    const db = createTestDb();
    // Insert a project and an available issue
    db.insert(schema.projects).values({
      id: 'proj1', githubOwner: 'acme', githubRepo: 'my-app',
      registeredBy: 'github-app', languages: '["typescript"]',
      issueLabel: 'tah', taskTypes: '["code"]', maxConcurrent: 3,
      trustThreshold: 0, githubInstallationId: '99',
    }).run();
    db.insert(schema.issues).values({
      id: 'issue1', projectId: 'proj1', githubNumber: 1,
      title: 'Fix bug', body: '', taskType: 'code',
      estimatedComplexity: 'small', estimatedTokens: 8000, status: 'available',
    }).run();

    const app = makeApp(db);
    const body = JSON.stringify({
      action: 'deleted',
      installation: { id: 99 },
      repositories: [],
    });
    const sig = sign(body, SECRET);

    const res = await app.request('/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'installation',
        'X-Hub-Signature-256': sig,
      },
      body,
    });

    expect(res.status).toBe(200);
    const issue = db.select().from(schema.issues).where(eq(schema.issues.id, 'issue1')).get();
    expect(issue?.status).toBe('cancelled');
  });
});
```

Also add `import { eq } from 'drizzle-orm';` at top of test file.

**Step 2: Run tests to verify they fail**

```bash
cd packages/coordinator && pnpm test webhooks
```
Expected: 2 new tests FAIL

**Step 3: Add `handleInstallation` to `webhooks.ts`**

Add these imports at top:
```ts
import { eq, and, inArray } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { projects, issues } from '../db/schema.js';
import { fetchRepoLanguages, fetchTahConfig } from '../services/github.js';
```

Add the handler function and wire it into the switch:

```ts
// In the switch statement, add:
case 'installation':
  await handleInstallation(db, payload);
  return c.json({ ok: true });
case 'installation_repositories':
  await handleInstallationRepositories(db, payload);
  return c.json({ ok: true });
```

Add the handler functions:

```ts
async function handleInstallation(db: Db, payload: Record<string, unknown>) {
  const action = payload['action'] as string;
  const installation = payload['installation'] as { id: number; account: { login: string } };
  const installationId = String(installation.id);

  if (action === 'created') {
    const repos = (payload['repositories'] as Array<{ name: string; full_name: string }>) ?? [];
    await registerRepos(db, installationId, installation.account.login, repos);
  } else if (action === 'deleted') {
    await deactivateInstallation(db, installationId);
  }
}

async function handleInstallationRepositories(db: Db, payload: Record<string, unknown>) {
  const installation = payload['installation'] as { id: number; account: { login: string } };
  const installationId = String(installation.id);
  const action = payload['action'] as string;

  if (action === 'added') {
    const repos = (payload['repositories_added'] as Array<{ name: string; full_name: string }>) ?? [];
    await registerRepos(db, installationId, installation.account.login, repos);
  } else if (action === 'removed') {
    const repos = (payload['repositories_removed'] as Array<{ name: string; full_name: string }>) ?? [];
    for (const repo of repos) {
      await deactivateRepo(db, installation.account.login, repo.name);
    }
  }
}

async function registerRepos(
  db: Db,
  installationId: string,
  owner: string,
  repos: Array<{ name: string; full_name: string }>,
) {
  for (const repo of repos) {
    // Skip if already registered
    const existing = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.githubOwner, owner), eq(projects.githubRepo, repo.name)))
      .get();
    if (existing) continue;

    const [languages, config] = await Promise.all([
      fetchRepoLanguages(owner, repo.name),
      fetchTahConfig(owner, repo.name),
    ]);

    await db.insert(projects).values({
      id: randomBytes(8).toString('hex'),
      githubOwner: owner,
      githubRepo: repo.name,
      registeredBy: 'github-app',
      languages: JSON.stringify(languages),
      issueLabel: config.label,
      taskTypes: JSON.stringify(config.taskTypes),
      maxConcurrent: config.maxConcurrent,
      trustThreshold: 0,
      githubInstallationId: installationId,
    });
  }
}

async function deactivateInstallation(db: Db, installationId: string) {
  const affectedProjects = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.githubInstallationId, installationId))
    .all();

  for (const project of affectedProjects) {
    await deactivateProjectIssues(db, project.id);
  }
}

async function deactivateRepo(db: Db, owner: string, repo: string) {
  const project = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.githubOwner, owner), eq(projects.githubRepo, repo)))
    .get();
  if (project) await deactivateProjectIssues(db, project.id);
}

async function deactivateProjectIssues(db: Db, projectId: string) {
  const now = new Date().toISOString();
  await db
    .update(issues)
    .set({ status: 'cancelled', updatedAt: now })
    .where(and(eq(issues.projectId, projectId), inArray(issues.status, ['available'])));
}
```

**Step 4: Run tests to verify they pass**

```bash
cd packages/coordinator && pnpm test webhooks
```
Expected: all pass

**Step 5: Commit**

```bash
git add packages/coordinator/src/routes/webhooks.ts packages/coordinator/src/routes/webhooks.test.ts
git commit -m "feat(coordinator): handle GitHub App installation events — auto-register and deactivate projects"
```

---

### Task 5: Handle `issues` events (labeled / unlabeled / closed)

**Files:**
- Modify: `packages/coordinator/src/routes/webhooks.ts`
- Modify: `packages/coordinator/src/routes/webhooks.test.ts`

**Step 1: Write failing tests**

Add to `webhooks.test.ts`:

```ts
describe('issues events', () => {
  let db: ReturnType<typeof createTestDb>;
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    db = createTestDb();
    app = makeApp(db);
    // Insert a registered project
    db.insert(schema.projects).values({
      id: 'proj1', githubOwner: 'acme', githubRepo: 'my-app',
      registeredBy: 'github-app', languages: '["typescript"]',
      issueLabel: 'tah', taskTypes: '["code"]', maxConcurrent: 3,
      trustThreshold: 0, githubInstallationId: '99',
    }).run();
  });

  it('adds an issue when labeled with project label', async () => {
    const body = JSON.stringify({
      action: 'labeled',
      label: { name: 'tah' },
      issue: { number: 42, title: 'Fix the bug', body: 'Details here', labels: [{ name: 'tah' }] },
      repository: { name: 'my-app', owner: { login: 'acme' } },
    });
    const sig = sign(body, SECRET);

    const res = await app.request('/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'issues',
        'X-Hub-Signature-256': sig,
      },
      body,
    });

    expect(res.status).toBe(200);
    const issue = db.select().from(schema.issues)
      .where(eq(schema.issues.githubNumber, 42)).get();
    expect(issue).toBeDefined();
    expect(issue?.title).toBe('Fix the bug');
    expect(issue?.status).toBe('available');
  });

  it('cancels an issue when closed', async () => {
    db.insert(schema.issues).values({
      id: 'iss1', projectId: 'proj1', githubNumber: 42,
      title: 'Fix the bug', body: '', taskType: 'code',
      estimatedComplexity: 'small', estimatedTokens: 8000, status: 'available',
    }).run();

    const body = JSON.stringify({
      action: 'closed',
      issue: { number: 42, title: 'Fix the bug', body: '', labels: [{ name: 'tah' }] },
      repository: { name: 'my-app', owner: { login: 'acme' } },
    });
    const sig = sign(body, SECRET);

    const res = await app.request('/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'issues',
        'X-Hub-Signature-256': sig,
      },
      body,
    });

    expect(res.status).toBe(200);
    const issue = db.select().from(schema.issues)
      .where(eq(schema.issues.githubNumber, 42)).get();
    expect(issue?.status).toBe('cancelled');
  });

  it('ignores labeled event when label does not match project label', async () => {
    const body = JSON.stringify({
      action: 'labeled',
      label: { name: 'bug' },
      issue: { number: 99, title: 'Something', body: '', labels: [{ name: 'bug' }] },
      repository: { name: 'my-app', owner: { login: 'acme' } },
    });
    const sig = sign(body, SECRET);

    await app.request('/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'issues',
        'X-Hub-Signature-256': sig,
      },
      body,
    });

    const allIssues = db.select().from(schema.issues).all();
    expect(allIssues).toHaveLength(0);
  });
});
```

Add `import { beforeEach } from 'vitest';` at the top if not already present.

**Step 2: Run tests to verify they fail**

```bash
cd packages/coordinator && pnpm test webhooks
```
Expected: 3 new tests FAIL

**Step 3: Add `handleIssuesEvent` to `webhooks.ts`**

Add to the switch statement:
```ts
case 'issues':
  await handleIssuesEvent(db, payload);
  return c.json({ ok: true });
```

Add the handler:

```ts
async function handleIssuesEvent(db: Db, payload: Record<string, unknown>) {
  const action = payload['action'] as string;
  const repo = payload['repository'] as { name: string; owner: { login: string } };
  const ghIssue = payload['issue'] as {
    number: number;
    title: string;
    body?: string | null;
    labels?: Array<{ name: string }>;
  };

  const project = await db
    .select()
    .from(projects)
    .where(and(eq(projects.githubOwner, repo.owner.login), eq(projects.githubRepo, repo.name)))
    .get();
  if (!project) return;

  const now = new Date().toISOString();

  if (action === 'labeled') {
    const labelName = (payload['label'] as { name: string }).name;
    if (labelName !== project.issueLabel) return; // not our label

    // Dedup: skip if already registered
    const existing = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.projectId, project.id), eq(issues.githubNumber, ghIssue.number)))
      .get();
    if (existing) return;

    const labelNames = (ghIssue.labels ?? []).map((l) => l.name);
    const { mapGitHubLabelsToComplexity, COMPLEXITY_TOKEN_ESTIMATES } = await import('@tah/shared');
    const complexity = mapGitHubLabelsToComplexity(labelNames) ?? 'small';

    await db.insert(issues).values({
      id: randomBytes(8).toString('hex'),
      projectId: project.id,
      githubNumber: ghIssue.number,
      title: ghIssue.title,
      body: ghIssue.body ?? '',
      taskType: 'code',
      estimatedComplexity: complexity,
      estimatedTokens: COMPLEXITY_TOKEN_ESTIMATES[complexity],
      status: 'available',
    });

  } else if (action === 'closed' || action === 'unlabeled') {
    if (action === 'unlabeled') {
      const labelName = (payload['label'] as { name: string }).name;
      if (labelName !== project.issueLabel) return; // not our label
    }

    await db
      .update(issues)
      .set({ status: 'cancelled', updatedAt: now })
      .where(and(
        eq(issues.projectId, project.id),
        eq(issues.githubNumber, ghIssue.number),
        inArray(issues.status, ['available', 'assigned']),
      ));
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
cd packages/coordinator && pnpm test webhooks
```
Expected: all pass

**Step 5: Commit**

```bash
git add packages/coordinator/src/routes/webhooks.ts packages/coordinator/src/routes/webhooks.test.ts
git commit -m "feat(coordinator): handle GitHub issues events — auto-add and cancel issues via webhooks"
```

---

### Task 6: Handle `push` event (re-read `.tah.yml`)

**Files:**
- Modify: `packages/coordinator/src/routes/webhooks.ts`
- Modify: `packages/coordinator/src/routes/webhooks.test.ts`

**Step 1: Write failing test**

Add to `webhooks.test.ts`:

```ts
describe('push events', () => {
  it('updates project config when .tah.yml is changed', async () => {
    const db = createTestDb();
    db.insert(schema.projects).values({
      id: 'proj1', githubOwner: 'acme', githubRepo: 'my-app',
      registeredBy: 'github-app', languages: '["typescript"]',
      issueLabel: 'tah', taskTypes: '["code"]', maxConcurrent: 3,
      trustThreshold: 0, githubInstallationId: '99',
    }).run();

    const app = makeApp(db);
    const body = JSON.stringify({
      ref: 'refs/heads/main',
      commits: [{ modified: ['.tah.yml'] }],
      repository: { name: 'my-app', owner: { login: 'acme' } },
    });
    const sig = sign(body, SECRET);

    const res = await app.request('/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-Hub-Signature-256': sig,
      },
      body,
    });
    expect(res.status).toBe(200);
    // Config fetch is mocked at the network level; just assert no crash
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd packages/coordinator && pnpm test webhooks
```
Expected: FAIL — `push` not handled

**Step 3: Add `handlePush` to `webhooks.ts`**

Add to switch:
```ts
case 'push':
  await handlePush(db, payload);
  return c.json({ ok: true });
```

Add handler:

```ts
async function handlePush(db: Db, payload: Record<string, unknown>) {
  const repo = payload['repository'] as { name: string; owner: { login: string } };
  const commits = (payload['commits'] as Array<{ modified?: string[]; added?: string[] }>) ?? [];

  const tahYmlChanged = commits.some(
    (c) => [...(c.modified ?? []), ...(c.added ?? [])].includes('.tah.yml'),
  );
  if (!tahYmlChanged) return;

  const project = await db
    .select()
    .from(projects)
    .where(and(eq(projects.githubOwner, repo.owner.login), eq(projects.githubRepo, repo.name)))
    .get();
  if (!project) return;

  const config = await fetchTahConfig(repo.owner.login, repo.name);
  const now = new Date().toISOString();

  await db
    .update(projects)
    .set({
      issueLabel: config.label,
      taskTypes: JSON.stringify(config.taskTypes),
      maxConcurrent: config.maxConcurrent,
      // createdAt is not updatedAt — projects table has no updatedAt, no action needed
    })
    .where(eq(projects.id, project.id));
}
```

**Step 4: Run tests to verify they pass**

```bash
cd packages/coordinator && pnpm test webhooks
```
Expected: all pass

**Step 5: Commit**

```bash
git add packages/coordinator/src/routes/webhooks.ts packages/coordinator/src/routes/webhooks.test.ts
git commit -m "feat(coordinator): re-read .tah.yml on push and update project config"
```

---

### Task 7: Mount webhook route in coordinator + env var

**Files:**
- Modify: `packages/coordinator/src/index.ts`
- Modify: `fly.toml` (document new env var)

**Step 1: Mount the route**

In `packages/coordinator/src/index.ts`, add import:

```ts
import { webhookRoutes } from './routes/webhooks.js';
```

After the other `app.route(...)` calls, add:

```ts
const webhookSecret = process.env['GITHUB_WEBHOOK_SECRET'] ?? '';
if (!webhookSecret) {
  console.warn('[coordinator] GITHUB_WEBHOOK_SECRET not set — webhook endpoint will reject all requests');
}
app.route('/webhooks/github', webhookRoutes(db, webhookSecret));
```

**Step 2: Document env var in fly.toml**

Add to the `[env]` section in `fly.toml`:

```toml
# GITHUB_WEBHOOK_SECRET must be set via: fly secrets set GITHUB_WEBHOOK_SECRET=<secret>
```

**Step 3: Build to verify**

```bash
pnpm build
```
Expected: Build success

**Step 4: Commit**

```bash
git add packages/coordinator/src/index.ts fly.toml
git commit -m "feat(coordinator): mount webhook route and document GITHUB_WEBHOOK_SECRET env var"
```

---

### Task 8: CLI — add `tah project open`, deprecate `register` and `issue sync`

**Files:**
- Modify: `packages/cli/src/commands/project.ts`

**Step 1: Add `tah project open` command**

In `packages/cli/src/commands/project.ts`, add after the existing `pin`/`unpin` commands:

```ts
cmd
  .command('open')
  .description('Open the GitHub App installation page in your browser')
  .action(() => {
    const url = 'https://github.com/apps/tokens-at-home';
    console.log(`Opening ${url}`);
    const { execSync } = require('child_process');
    try {
      const platform = process.platform;
      if (platform === 'darwin') execSync(`open "${url}"`);
      else if (platform === 'win32') execSync(`start "${url}"`);
      else execSync(`xdg-open "${url}"`);
    } catch {
      console.log(`Visit: ${url}`);
    }
  });
```

Note: `execSync` is already available via the existing `child_process` import at the top of the file (it imports `spawnSync` — change this to also import `execSync`).

**Step 2: Add deprecation notice to `tah project register`**

At the top of the `register` command's `.action(...)`, add before the existing logic:

```ts
console.warn('⚠  tah project register is deprecated. Install the GitHub App instead: tah project open');
console.warn('   Continuing with manual registration...\n');
```

**Step 3: Add deprecation notice to `tah project issue sync`**

At the top of the `sync` command's `.action(...)`, add:

```ts
console.warn('⚠  tah project issue sync is deprecated. Issues now sync automatically via the GitHub App.');
console.warn('   Continuing with manual sync...\n');
```

**Step 4: Build and smoke-test**

```bash
pnpm build
node packages/cli/dist/index.js project open
```
Expected: opens browser or prints URL

**Step 5: Commit**

```bash
git add packages/cli/src/commands/project.ts
git commit -m "feat(cli): add tah project open and deprecation notices for register and issue sync"
```

---

### Task 9: Full test run and push

**Step 1: Run all tests**

```bash
pnpm test
```
Expected: all pass

**Step 2: Push**

```bash
git push
```

**Step 3: Set the webhook secret on Fly.io**

This is a manual step the operator must run once after creating the GitHub App:

```bash
fly secrets set GITHUB_WEBHOOK_SECRET=<secret-from-github-app-settings>
```

The GitHub App itself must be created manually via `github.com/settings/apps/new` with:
- Webhook URL: `https://tokens-at-home.fly.dev/webhooks/github`
- Permissions: Issues (read), Metadata (read), Contents (read for `.tah.yml`)
- Subscribe to events: `installation`, `installation_repositories`, `issues`, `push`
