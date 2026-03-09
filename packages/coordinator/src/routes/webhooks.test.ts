import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac } from 'crypto';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
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

describe('issues events', () => {
  let db: ReturnType<typeof createTestDb>;
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    db = createTestDb();
    app = makeApp(db);
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

  it('removes project and issues on installation.deleted', async () => {
    const db = createTestDb();
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
    expect(issue).toBeUndefined();
    const project = db.select().from(schema.projects).where(eq(schema.projects.id, 'proj1')).get();
    expect(project).toBeUndefined();
  });
});

describe('push events', () => {
  it('returns 200 and does not crash when .tah.yml is changed', async () => {
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
  });

  it('does nothing when .tah.yml is not in the push', async () => {
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
      commits: [{ modified: ['src/index.ts'] }],
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
  });
});
