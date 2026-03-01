import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema.js';
import { initSchema } from '../db/index.js';
import { projectRoutes } from './projects.js';
import { contributorRoutes } from './contributors.js';
import { taskRoutes } from './tasks.js';
import type { Project, Contributor, Task, Issue } from '@tah/shared';

// Create an in-memory database for tests
function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  // initSchema needs the raw sqlite instance
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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS contributors (
      id TEXT PRIMARY KEY,
      github_username TEXT NOT NULL UNIQUE,
      languages TEXT NOT NULL DEFAULT '[]',
      autonomy TEXT NOT NULL DEFAULT 'review_before_pr',
      cycle_reset_date TEXT,
      max_concurrent INTEGER NOT NULL DEFAULT 1,
      trust_score REAL NOT NULL DEFAULT 0,
      available INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS pledges (
      id TEXT PRIMARY KEY,
      contributor_id TEXT NOT NULL REFERENCES contributors(id),
      project_id TEXT NOT NULL REFERENCES projects(id),
      budget_percent REAL NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
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
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL REFERENCES issues(id),
      contributor_id TEXT NOT NULL REFERENCES contributors(id),
      pledge_id TEXT,
      status TEXT NOT NULL DEFAULT 'dispatched',
      tokens_used INTEGER,
      pr_url TEXT,
      summary TEXT,
      error_details TEXT,
      last_heartbeat_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS auth_tokens (
      id TEXT PRIMARY KEY,
      contributor_id TEXT NOT NULL REFERENCES contributors(id),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

async function registerContributor(app: Hono, data = {}) {
  const res = await app.request('/contributors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      githubUsername: 'testuser',
      languages: ['typescript'],
      ...data,
    }),
  });
  return res;
}

describe('Coordinator API', () => {
  let app: Hono;
  let db: ReturnType<typeof createTestDb>;
  let authToken: string;
  let contributorId: string;

  beforeEach(async () => {
    db = createTestDb();
    app = new Hono();
    app.route('/contributors', contributorRoutes(db));
    app.route('/projects', projectRoutes(db));
    app.route('/tasks', taskRoutes(db));

    // Register a contributor
    const res = await registerContributor(app);
    expect(res.status).toBe(201);
    const data = await res.json() as { contributor: Contributor; token: string };
    authToken = data.token;
    contributorId = data.contributor.id;
  });

  describe('POST /contributors', () => {
    it('registers a new contributor and returns a token', async () => {
      const res = await app.request('/contributors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          githubUsername: 'newuser',
          languages: ['python'],
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as { contributor: Contributor; token: string };
      expect(body.contributor.githubUsername).toBe('newuser');
      expect(typeof body.token).toBe('string');
      expect(body.token.length).toBeGreaterThan(20);
    });

    it('rejects duplicate username', async () => {
      const res = await registerContributor(app);
      expect(res.status).toBe(409);
    });
  });

  describe('GET /contributors/me', () => {
    it('returns the contributor profile with valid token', async () => {
      const res = await app.request('/contributors/me', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      expect(res.status).toBe(200);
      const contributor = await res.json() as Contributor;
      expect(contributor.githubUsername).toBe('testuser');
    });

    it('returns 401 without token', async () => {
      const res = await app.request('/contributors/me');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /projects', () => {
    it('creates a project with valid auth', async () => {
      const res = await app.request('/projects', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          githubOwner: 'facebook',
          githubRepo: 'react',
          languages: ['javascript', 'typescript'],
        }),
      });
      expect(res.status).toBe(201);
      const project = await res.json() as Project;
      expect(project.githubOwner).toBe('facebook');
      expect(project.githubRepo).toBe('react');
      expect(project.languages).toEqual(['javascript', 'typescript']);
    });

    it('returns 401 without auth', async () => {
      const res = await app.request('/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          githubOwner: 'foo',
          githubRepo: 'bar',
          languages: ['go'],
        }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('Task lifecycle', () => {
    let projectId: string;
    let issueId: string;

    beforeEach(async () => {
      // Create a project
      const pRes = await app.request('/projects', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          githubOwner: 'test',
          githubRepo: 'repo',
          languages: ['typescript'],
        }),
      });
      const project = await pRes.json() as Project;
      projectId = project.id;

      // Register an issue
      const iRes = await app.request(`/projects/${projectId}/issues`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          githubNumber: 42,
          title: 'Fix bug',
          body: 'Something broke',
          taskType: 'code',
        }),
      });
      expect(iRes.status).toBe(201);
      const issue = await iRes.json() as Issue;
      issueId = issue.id;
    });

    it('assigns a task and returns it on /tasks/next', async () => {
      // Assign the task
      const assignRes = await app.request('/tasks/assign', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ issueId, contributorId }),
      });
      expect(assignRes.status).toBe(201);

      // Poll for next task
      const nextRes = await app.request('/tasks/next', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      expect(nextRes.status).toBe(200);
      const assignment = await nextRes.json() as { task: Task; issue: Issue };
      expect(assignment.task.issueId).toBe(issueId);
      expect(assignment.issue.githubNumber).toBe(42);
    });

    it('returns 204 when no tasks are available', async () => {
      const res = await app.request('/tasks/next', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      expect(res.status).toBe(204);
    });

    it('can complete a task', async () => {
      // Assign
      const assignRes = await app.request('/tasks/assign', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ issueId, contributorId }),
      });
      const task = await assignRes.json() as Task;

      // Complete
      const completeRes = await app.request(`/tasks/${task.id}/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          prUrl: 'https://github.com/test/repo/pull/1',
          tokensUsed: 5000,
          summary: 'Fixed the bug',
        }),
      });
      expect(completeRes.status).toBe(200);

      // Issue should now be 'submitted'
      const issuesRes = await app.request(`/projects/${projectId}/issues`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const issues = await issuesRes.json() as Issue[];
      expect(issues[0]?.status).toBe('submitted');
    });
  });

  describe('Availability', () => {
    it('can set and check availability', async () => {
      const setRes = await app.request('/contributors/me/available', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ available: true }),
      });
      expect(setRes.status).toBe(200);

      const meRes = await app.request('/contributors/me', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const me = await meRes.json() as Contributor;
      expect(me.available).toBe(true);
    });
  });

  describe('Auto-matching on /tasks/next', () => {
    let projectId: string;
    let issueId: string;

    beforeEach(async () => {
      // Register a project
      const pRes = await app.request('/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          githubOwner: 'acme',
          githubRepo: 'widget',
          languages: ['typescript'],
        }),
      });
      const project = await pRes.json() as Project;
      projectId = project.id;

      // Register an issue
      const iRes = await app.request(`/projects/${projectId}/issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ githubNumber: 99, title: 'Auto-fix', body: '', taskType: 'code' }),
      });
      const issue = await iRes.json() as Issue;
      issueId = issue.id;

      // Pledge to the project
      await app.request('/contributors/me/pledges', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ projectId, budgetPercent: 80 }),
      });
    });

    it('returns 204 when contributor is unavailable', async () => {
      // available defaults to false — no mark-available call
      const res = await app.request('/tasks/next', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      expect(res.status).toBe(204);
    });

    it('auto-creates and returns a task when contributor is available with a matching pledge', async () => {
      await app.request('/contributors/me/available', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ available: true }),
      });

      const res = await app.request('/tasks/next', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      expect(res.status).toBe(200);

      const body = await res.json() as { task: Task; issue: Issue; project: Project };
      expect(body.task.contributorId).toBe(contributorId);
      expect(body.task.status).toBe('dispatched');
      expect(body.issue.id).toBe(issueId);
      expect(body.project.githubRepo).toBe('widget');
    });

    it('marks the issue as assigned after auto-matching', async () => {
      await app.request('/contributors/me/available', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ available: true }),
      });

      await app.request('/tasks/next', { headers: { Authorization: `Bearer ${authToken}` } });

      const issuesRes = await app.request(`/projects/${projectId}/issues`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const issueList = await issuesRes.json() as Issue[];
      expect(issueList[0]?.status).toBe('assigned');
    });

    it('does not double-assign: second poll returns same task', async () => {
      await app.request('/contributors/me/available', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ available: true }),
      });

      const first = await app.request('/tasks/next', { headers: { Authorization: `Bearer ${authToken}` } });
      const second = await app.request('/tasks/next', { headers: { Authorization: `Bearer ${authToken}` } });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const t1 = (await first.json() as { task: Task }).task;
      const t2 = (await second.json() as { task: Task }).task;
      expect(t1.id).toBe(t2.id);
    });
  });
});
