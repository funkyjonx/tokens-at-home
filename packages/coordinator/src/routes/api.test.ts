import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema.js';
import { initSchema } from '../db/index.js';
import { projectRoutes } from './projects.js';
import { contributorRoutes } from './contributors.js';
import { taskRoutes } from './tasks.js';
import { leaderboardRoutes } from './leaderboard.js';
import type { Project, Contributor, Task, Issue, LeaderboardEntry, PublicContributor, ProjectStats } from '@tah/shared';

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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      github_installation_id TEXT
    );
    CREATE TABLE IF NOT EXISTS contributors (
      id TEXT PRIMARY KEY,
      github_username TEXT NOT NULL UNIQUE,
      languages TEXT NOT NULL DEFAULT '[]',
      max_complexity TEXT NOT NULL DEFAULT 'medium',
      max_concurrent INTEGER NOT NULL DEFAULT 1,
      trust_score REAL NOT NULL DEFAULT 0,
      available INTEGER NOT NULL DEFAULT 0,
      task_budget INTEGER,
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
      status TEXT NOT NULL DEFAULT 'dispatched',
      phase_started_at TEXT,
      tokens_used INTEGER,
      pr_url TEXT,
      summary TEXT,
      error_details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS task_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      phase TEXT NOT NULL,
      tokens_used INTEGER,
      elapsed_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS auth_tokens (
      id TEXT PRIMARY KEY,
      contributor_id TEXT NOT NULL REFERENCES contributors(id),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS project_pins (
      id TEXT PRIMARY KEY,
      contributor_id TEXT NOT NULL REFERENCES contributors(id),
      project_id TEXT NOT NULL REFERENCES projects(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(contributor_id, project_id)
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
    app.route('/leaderboard', leaderboardRoutes(db));

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

    it('does not expose trustScore, autonomy, or cycleResetDate', async () => {
      const res = await app.request('/contributors/me', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body).not.toHaveProperty('trustScore');
      expect(body).not.toHaveProperty('autonomy');
      expect(body).not.toHaveProperty('cycleResetDate');
    });
  });

  describe('PATCH /contributors/me', () => {
    it('updates languages', async () => {
      const res = await app.request('/contributors/me', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ languages: ['python', 'rust'] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { githubUsername: string; languages: string[] };
      expect(body.languages).toEqual(['python', 'rust']);
    });

    it('updates maxComplexity', async () => {
      const res = await app.request('/contributors/me', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ maxComplexity: 'large' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { maxComplexity: string };
      expect(body.maxComplexity).toBe('large');
    });

    it('rejects invalid data', async () => {
      const res = await app.request('/contributors/me', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ maxConcurrent: 99 }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 401 without token', async () => {
      const res = await app.request('/contributors/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ languages: ['go'] }),
      });
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

      // Pin the project
      await app.request('/contributors/me/pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ projectId }),
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

    it('does not double-assign: second poll returns same task (specific pledge)', async () => {
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

  describe('contributor pin endpoints', () => {
    let projectId: string;

    beforeEach(async () => {
      const pRes = await app.request('/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ githubOwner: 'pinorg', githubRepo: 'pinrepo', languages: ['typescript'] }),
      });
      const project = await pRes.json() as Project;
      projectId = project.id;
    });

    it('POST /contributors/me/pins adds a pin (201, returns pin object)', async () => {
      const res = await app.request('/contributors/me/pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ projectId }),
      });
      expect(res.status).toBe(201);
      const pin = await res.json() as { id: string; projectId: string; createdAt: string };
      expect(pin.projectId).toBe(projectId);
      expect(typeof pin.id).toBe('string');
      expect(typeof pin.createdAt).toBe('string');
    });

    it('POST /contributors/me/pins returns 409 if already pinned', async () => {
      await app.request('/contributors/me/pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ projectId }),
      });
      const res2 = await app.request('/contributors/me/pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ projectId }),
      });
      expect(res2.status).toBe(409);
    });

    it('DELETE /contributors/me/pins/:projectId removes a pin (200)', async () => {
      await app.request('/contributors/me/pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ projectId }),
      });
      const delRes = await app.request(`/contributors/me/pins/${projectId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      expect(delRes.status).toBe(200);
      const body = await delRes.json() as { ok: boolean };
      expect(body.ok).toBe(true);

      // Verify it's gone
      const listRes = await app.request('/contributors/me/pins', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const pins = await listRes.json() as { id: string }[];
      expect(pins.length).toBe(0);
    });

    it('GET /contributors/me/pins lists pins with project info', async () => {
      await app.request('/contributors/me/pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ projectId }),
      });
      const res = await app.request('/contributors/me/pins', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      expect(res.status).toBe(200);
      const pins = await res.json() as { id: string; projectId: string; githubOwner: string; githubRepo: string; createdAt: string }[];
      expect(pins.length).toBe(1);
      expect(pins[0]?.projectId).toBe(projectId);
      expect(pins[0]?.githubOwner).toBe('pinorg');
      expect(pins[0]?.githubRepo).toBe('pinrepo');
    });
  });

  describe('GET /leaderboard', () => {
    let projectId: string;

    beforeEach(async () => {
      // Create a project and issue, then complete a task
      const pRes = await app.request('/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ githubOwner: 'lb', githubRepo: 'test', languages: ['typescript'] }),
      });
      const project = await pRes.json() as Project;
      projectId = project.id;

      const iRes = await app.request(`/projects/${projectId}/issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ githubNumber: 1, title: 'LB issue', body: '', taskType: 'code' }),
      });
      const issue = await iRes.json() as Issue;

      const assignRes = await app.request('/tasks/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ issueId: issue.id, contributorId }),
      });
      const task = await assignRes.json() as Task;

      await app.request(`/tasks/${task.id}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ prUrl: 'https://github.com/lb/test/pull/1', tokensUsed: 3000, summary: 'done' }),
      });
    });

    it('returns leaderboard entries after a completed task', async () => {
      const res = await app.request('/leaderboard');
      expect(res.status).toBe(200);
      const entries = await res.json() as LeaderboardEntry[];
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0]?.rank).toBe(1);
      expect(entries[0]?.githubUsername).toBe('testuser');
      expect(entries[0]?.tasksCompleted).toBe(1);
      expect(entries[0]?.totalTokensDonated).toBe(3000);
    });

    it('returns empty array when no completed tasks', async () => {
      // Fresh db
      const freshDb = createTestDb();
      const freshApp = new Hono();
      freshApp.route('/leaderboard', leaderboardRoutes(freshDb));
      const res = await freshApp.request('/leaderboard');
      expect(res.status).toBe(200);
      const entries = await res.json() as LeaderboardEntry[];
      expect(entries).toEqual([]);
    });

    it('supports period filter', async () => {
      const res = await app.request('/leaderboard?period=week');
      expect(res.status).toBe(200);
      const entries = await res.json() as LeaderboardEntry[];
      // Task was just created so should appear in week
      expect(entries.length).toBeGreaterThan(0);
    });

    it('respects limit param', async () => {
      const res = await app.request('/leaderboard?limit=1');
      expect(res.status).toBe(200);
      const entries = await res.json() as LeaderboardEntry[];
      expect(entries.length).toBeLessThanOrEqual(1);
    });
  });

  describe('GET /projects (search)', () => {
    beforeEach(async () => {
      await app.request('/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ githubOwner: 'searchorg', githubRepo: 'myreact', languages: ['typescript'] }),
      });
      await app.request('/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ githubOwner: 'other', githubRepo: 'vue', languages: ['javascript'] }),
      });
    });

    it('filters projects by query', async () => {
      const res = await app.request('/projects?q=react');
      expect(res.status).toBe(200);
      const projects = await res.json() as Project[];
      expect(projects.every((p) => p.githubOwner.includes('react') || p.githubRepo.includes('react'))).toBe(true);
      expect(projects.find((p) => p.githubRepo === 'myreact')).toBeTruthy();
      expect(projects.find((p) => p.githubRepo === 'vue')).toBeFalsy();
    });

    it('filters projects by language', async () => {
      const res = await app.request('/projects?language=javascript');
      expect(res.status).toBe(200);
      const projects = await res.json() as Project[];
      expect(projects.every((p) => p.languages.includes('javascript'))).toBe(true);
    });
  });

  describe('GET /projects/:id/stats', () => {
    let projectId: string;

    beforeEach(async () => {
      const pRes = await app.request('/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ githubOwner: 'stats', githubRepo: 'repo', languages: ['rust'] }),
      });
      const project = await pRes.json() as Project;
      projectId = project.id;

      // Register 2 issues
      for (const n of [10, 11]) {
        await app.request(`/projects/${projectId}/issues`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ githubNumber: n, title: `Issue ${n}`, body: '', taskType: 'code' }),
        });
      }

      // Complete a task for issue 10
      const issuesRes = await app.request(`/projects/${projectId}/issues`);
      const issues = await issuesRes.json() as Issue[];
      const issue10 = issues.find((i) => i.githubNumber === 10)!;

      const assignRes = await app.request('/tasks/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ issueId: issue10.id, contributorId }),
      });
      const task = await assignRes.json() as Task;
      await app.request(`/tasks/${task.id}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ prUrl: 'https://github.com/stats/repo/pull/1', tokensUsed: 7500, summary: 'done' }),
      });
    });

    it('returns project stats', async () => {
      const res = await app.request(`/projects/${projectId}/stats`);
      expect(res.status).toBe(200);
      const stats = await res.json() as ProjectStats;
      expect(stats.totalTasksCompleted).toBe(1);
      expect(stats.totalTokensConsumed).toBe(7500);
      expect(stats.availableIssues).toBe(1); // issue 11 still available
      expect(stats.activeContributors).toBe(1);
      expect(stats.topContributors.length).toBe(1);
      expect(stats.topContributors[0]?.githubUsername).toBe('testuser');
    });

    it('returns 404 for unknown project', async () => {
      const res = await app.request('/projects/doesnotexist/stats');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /tasks/:id/progress', () => {
    let projectId: string;
    let issueId: string;
    let taskId: string;

    beforeEach(async () => {
      // Create a project
      const pRes = await app.request('/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ githubOwner: 'prog', githubRepo: 'repo', languages: ['typescript'] }),
      });
      const project = await pRes.json() as Project;
      projectId = project.id;

      // Register an issue
      const iRes = await app.request(`/projects/${projectId}/issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ githubNumber: 55, title: 'Progress issue', body: '', taskType: 'code' }),
      });
      const issue = await iRes.json() as Issue;
      issueId = issue.id;

      // Assign the task
      const assignRes = await app.request('/tasks/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ issueId, contributorId }),
      });
      const task = await assignRes.json() as Task;
      taskId = task.id;
    });

    it('records a phase event and updates task status', async () => {
      const res = await app.request(`/tasks/${taskId}/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ phase: 'cloning' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean };
      expect(body.ok).toBe(true);

      // Verify task status updated
      const taskRes = await app.request(`/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      expect(taskRes.status).toBe(200);
      const updatedTask = await taskRes.json() as Task;
      expect(updatedTask.status).toBe('cloning');
    });

    it('returns 400 for terminal status phases', async () => {
      const res = await app.request(`/tasks/${taskId}/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ phase: 'completed' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Cannot set terminal status via progress endpoint');
    });

    it('returns 409 when task is already completed', async () => {
      // Complete the task first
      await app.request(`/tasks/${taskId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ prUrl: 'https://github.com/prog/repo/pull/1', tokensUsed: 1000, summary: 'done' }),
      });

      // Now try to post a progress event
      const res = await app.request(`/tasks/${taskId}/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ phase: 'working' }),
      });
      expect(res.status).toBe(409);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Task is already in a terminal state');
    });

    it('returns 401 without auth', async () => {
      const res = await app.request(`/tasks/${taskId}/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase: 'cloning' }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /contributors (public directory)', () => {
    beforeEach(async () => {
      // Register second contributor
      await app.request('/contributors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ githubUsername: 'alice', languages: ['rust'] }),
      });

      // Complete a task for testuser
      const pRes = await app.request('/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ githubOwner: 'cd', githubRepo: 'repo', languages: ['typescript'] }),
      });
      const project = await pRes.json() as Project;

      const iRes = await app.request(`/projects/${project.id}/issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ githubNumber: 5, title: 'CD issue', body: '', taskType: 'code' }),
      });
      const issue = await iRes.json() as Issue;

      const assignRes = await app.request('/tasks/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ issueId: issue.id, contributorId }),
      });
      const task = await assignRes.json() as Task;
      await app.request(`/tasks/${task.id}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ prUrl: 'https://github.com/cd/repo/pull/1', tokensUsed: 2000, summary: 'done' }),
      });
    });

    it('returns contributors with completed tasks', async () => {
      const res = await app.request('/contributors');
      expect(res.status).toBe(200);
      const results = await res.json() as PublicContributor[];
      // Only testuser has completed a task, not alice
      expect(results.some((r) => r.githubUsername === 'testuser')).toBe(true);
      expect(results.some((r) => r.githubUsername === 'alice')).toBe(false);
    });

    it('filters by query', async () => {
      const res = await app.request('/contributors?q=test');
      expect(res.status).toBe(200);
      const results = await res.json() as PublicContributor[];
      expect(results.every((r) => r.githubUsername.includes('test'))).toBe(true);
    });

    it('returns public fields only (no auth token)', async () => {
      const res = await app.request('/contributors');
      expect(res.status).toBe(200);
      const results = await res.json() as PublicContributor[];
      if (results.length > 0) {
        expect(results[0]).toHaveProperty('githubUsername');
        expect(results[0]).toHaveProperty('tasksCompleted');
        expect(results[0]).toHaveProperty('totalTokensDonated');
        expect(results[0]).not.toHaveProperty('autonomy');
        expect(results[0]).not.toHaveProperty('available');
      }
    });
  });

  describe('GET /contributors/:username/stats', () => {
    it('returns 404 for unknown contributor', async () => {
      const res = await app.request('/contributors/nobody_xyz/stats');
      expect(res.status).toBe(404);
    });

    it('returns stats for contributor with no completed tasks', async () => {
      const res = await app.request('/contributors/testuser/stats');
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body).toHaveProperty('allTime');
      expect(body).toHaveProperty('thisMonth');
    });

    it('returns correct stats shape', async () => {
      const res = await app.request('/contributors/testuser/stats');
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body).toHaveProperty('githubUsername', 'testuser');
      expect(body).toHaveProperty('allTime');
      expect(body).toHaveProperty('thisMonth');
      expect(body).toHaveProperty('topProjects');
      const allTime = body.allTime as Record<string, unknown>;
      expect(allTime).toHaveProperty('tasksCompleted');
      expect(allTime).toHaveProperty('tokensDonated');
      expect(allTime).toHaveProperty('successRate');
      expect(allTime).toHaveProperty('rank');
    });
  });

  describe('contributor budget', () => {
    it('registers with a task budget', async () => {
      const res = await app.request('/contributors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ githubUsername: 'budgetuser', languages: ['typescript'], taskBudget: 5 }),
      });
      expect(res.status).toBe(201);
      const data = await res.json() as { contributor: Contributor; token: string };
      expect(data.contributor.taskBudget).toBe(5);
    });

    it('registers without a task budget (unlimited)', async () => {
      const res = await app.request('/contributors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ githubUsername: 'unlimiteduser', languages: ['typescript'] }),
      });
      expect(res.status).toBe(201);
      const data = await res.json() as { contributor: Contributor; token: string };
      expect(data.contributor.taskBudget).toBeNull();
    });

    it('adds to budget via POST /contributors/me/budget', async () => {
      const res = await app.request('/contributors/me/budget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ add: 3 }),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as { taskBudget: number };
      expect(data.taskBudget).toBe(3);
    });

    it('stacks budget additions', async () => {
      await app.request('/contributors/me/budget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ add: 3 }),
      });
      const res = await app.request('/contributors/me/budget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ add: 2 }),
      });
      const data = await res.json() as { taskBudget: number };
      expect(data.taskBudget).toBe(5);
    });

    it('rejects invalid budget add values with 400', async () => {
      const res = await app.request('/contributors/me/budget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ add: 0 }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects unauthenticated budget add with 401', async () => {
      const res = await app.request('/contributors/me/budget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ add: 3 }),
      });
      expect(res.status).toBe(401);
    });
  });
});
