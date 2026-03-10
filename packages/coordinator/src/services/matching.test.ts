import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema.js';
import { scoreMatch, findMatchForContributor } from './matching.js';
import type { Contributor, Issue, Project } from '@tah/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      github_installation_id TEXT
    );
    CREATE TABLE IF NOT EXISTS contributors (
      id TEXT PRIMARY KEY,
      github_username TEXT NOT NULL UNIQUE,
      languages TEXT NOT NULL DEFAULT '[]',
      max_concurrent INTEGER NOT NULL DEFAULT 1,
      max_complexity TEXT NOT NULL DEFAULT 'medium',
      trust_score REAL NOT NULL DEFAULT 0,
      available INTEGER NOT NULL DEFAULT 0,
      task_budget INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS project_pins (
      id TEXT PRIMARY KEY,
      contributor_id TEXT NOT NULL REFERENCES contributors(id),
      project_id TEXT NOT NULL REFERENCES projects(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(contributor_id, project_id)
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
  `);
  return { db, sqlite };
}

// ---------------------------------------------------------------------------
// Fixtures for scoreMatch unit tests
// ---------------------------------------------------------------------------

const project: Project = {
  id: 'proj-1',
  githubOwner: 'acme',
  githubRepo: 'widget',
  registeredBy: 'alice',
  languages: ['typescript', 'rust'],
  issueLabel: 'tah',
  taskTypes: ['code'],
  maxConcurrent: 3,
  trustThreshold: 0,
  createdAt: '2024-01-01T00:00:00Z',
};

const contributor: Contributor = {
  id: 'contrib-1',
  githubUsername: 'alice',
  languages: ['typescript', 'python'],
  maxConcurrent: 1,
  maxComplexity: 'large',
  trustScore: 0,
  available: true,
  createdAt: '2024-01-01T00:00:00Z',
};

const issue: Issue = {
  id: 'issue-1',
  projectId: 'proj-1',
  githubNumber: 42,
  title: 'Fix widget',
  body: '',
  taskType: 'code',
  estimatedComplexity: 'small',
  estimatedTokens: 8_000,
  status: 'available',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

// ---------------------------------------------------------------------------
// scoreMatch unit tests
// ---------------------------------------------------------------------------

describe('scoreMatch', () => {
  it('returns a score > 0 for a valid matching pair', () => {
    const score = scoreMatch(contributor, issue, project, false);
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThan(0);
  });

  it('returns null when issue complexity exceeds contributor maxComplexity', () => {
    const cappedContributor = { ...contributor, maxComplexity: 'small' as const };
    const largeIssue = { ...issue, estimatedComplexity: 'large' as const };
    const score = scoreMatch(cappedContributor, largeIssue, project, false);
    expect(score).toBeNull();
  });

  it('accepts issue at exactly the complexity cap', () => {
    const cappedContributor = { ...contributor, maxComplexity: 'medium' as const };
    const mediumIssue = { ...issue, estimatedComplexity: 'medium' as const };
    const score = scoreMatch(cappedContributor, mediumIssue, project, false);
    expect(score).not.toBeNull();
  });

  it('pinned project gets higher score than unpinned, all else equal', () => {
    const pinnedScore = scoreMatch(contributor, issue, project, true);
    const unpinnedScore = scoreMatch(contributor, issue, project, false);
    expect(pinnedScore!).toBeGreaterThan(unpinnedScore!);
  });

  it('full language overlap gives higher score than partial overlap', () => {
    const fullOverlap = { ...contributor, languages: ['typescript', 'rust'] };
    const partialOverlap = { ...contributor, languages: ['typescript', 'python'] };
    const fullScore = scoreMatch(fullOverlap, issue, project, false);
    const partialScore = scoreMatch(partialOverlap, issue, project, false);
    expect(fullScore!).toBeGreaterThan(partialScore!);
  });

  it('partial language overlap gives lower score than full overlap', () => {
    const fullOverlap = { ...contributor, languages: ['typescript', 'rust'] };
    const partialOverlap = { ...contributor, languages: ['typescript', 'python'] };
    const fullScore = scoreMatch(fullOverlap, issue, project, false)!;
    const partialScore = scoreMatch(partialOverlap, issue, project, false)!;
    expect(fullScore).toBeGreaterThan(partialScore);
    expect(partialScore).toBeGreaterThan(0);
  });

  it('returns null when contributor shares no languages with the project', () => {
    const noOverlapContributor = { ...contributor, languages: ['rust'] };
    const tsJsProject = { ...project, languages: ['typescript', 'javascript'] };
    const result = scoreMatch(noOverlapContributor, issue, tsJsProject, false);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findMatchForContributor integration tests
// ---------------------------------------------------------------------------

describe('findMatchForContributor', () => {
  let db: ReturnType<typeof createTestDb>['db'];

  beforeEach(() => {
    ({ db } = createTestDb());
    // Insert base project and contributor for each test
    db.run(`
      INSERT INTO projects (id, github_owner, github_repo, registered_by, languages, task_types)
      VALUES ('proj-1', 'acme', 'widget', 'sys', '["typescript","rust"]', '["code"]')
    `);
    db.run(`
      INSERT INTO contributors (id, github_username, languages, max_concurrent, max_complexity, available)
      VALUES ('contrib-1', 'alice', '["typescript"]', 1, 'large', 1)
    `);
    db.run(`
      INSERT INTO issues (id, project_id, github_number, title, estimated_complexity, status)
      VALUES ('issue-1', 'proj-1', 1, 'Fix widget', 'small', 'available')
    `);
  });

  it('returns null when contributor does not exist', async () => {
    const result = await findMatchForContributor(db, 'no-such-contributor');
    expect(result).toBeNull();
  });

  it('returns null when contributor is unavailable', async () => {
    db.run(`UPDATE contributors SET available = 0 WHERE id = 'contrib-1'`);
    const result = await findMatchForContributor(db, 'contrib-1');
    expect(result).toBeNull();
  });

  it('returns null when contributor is at maxConcurrent', async () => {
    db.run(`UPDATE contributors SET max_concurrent = 1 WHERE id = 'contrib-1'`);
    // Insert a separate issue that is already assigned (realistic DB state for an active task)
    db.run(`
      INSERT INTO issues (id, project_id, github_number, title, estimated_complexity, status)
      VALUES ('issue-assigned', 'proj-1', 99, 'Active work', 'small', 'assigned')
    `);
    db.run(`
      INSERT INTO tasks (id, issue_id, contributor_id, status)
      VALUES ('task-1', 'issue-assigned', 'contrib-1', 'working')
    `);
    const result = await findMatchForContributor(db, 'contrib-1');
    expect(result).toBeNull();
  });

  it('returns null when no available issues exist', async () => {
    db.run(`UPDATE issues SET status = 'assigned' WHERE id = 'issue-1'`);
    const result = await findMatchForContributor(db, 'contrib-1');
    expect(result).toBeNull();
  });

  it('returns the best match when issues exist', async () => {
    const result = await findMatchForContributor(db, 'contrib-1');
    expect(result).not.toBeNull();
    expect(result!.issueId).toBe('issue-1');
    expect(result!.score).toBeGreaterThan(0);
  });

  it('pinned project issues score higher and are selected over unpinned', async () => {
    // Add a second project (no pin) and issue with identical complexity
    db.run(`
      INSERT INTO projects (id, github_owner, github_repo, registered_by, languages, task_types)
      VALUES ('proj-2', 'acme', 'other', 'sys', '["typescript","rust"]', '["code"]')
    `);
    db.run(`
      INSERT INTO issues (id, project_id, github_number, title, estimated_complexity, status)
      VALUES ('issue-2', 'proj-2', 2, 'Other issue', 'small', 'available')
    `);

    // Pin proj-1 for this contributor
    db.run(`
      INSERT INTO project_pins (id, contributor_id, project_id)
      VALUES ('pin-1', 'contrib-1', 'proj-1')
    `);

    const result = await findMatchForContributor(db, 'contrib-1');
    expect(result).not.toBeNull();
    // The pinned project's issue should win
    expect(result!.issueId).toBe('issue-1');
  });

  it('skips issues with complexity above contributor maxComplexity', async () => {
    db.run(`UPDATE contributors SET max_complexity = 'small' WHERE id = 'contrib-1'`);
    // Replace the available issue with a large one
    db.run(`UPDATE issues SET estimated_complexity = 'large' WHERE id = 'issue-1'`);
    const result = await findMatchForContributor(db, 'contrib-1');
    expect(result).toBeNull();
  });

  it('completed and failed tasks do not count against maxConcurrent', async () => {
    db.run(`UPDATE contributors SET max_concurrent = 1 WHERE id = 'contrib-1'`);
    // Insert a completed task (should not block)
    db.run(`
      INSERT INTO tasks (id, issue_id, contributor_id, status)
      VALUES ('task-old', 'issue-1', 'contrib-1', 'completed')
    `);
    // The issue is already 'available' (no real assignment conflict here — just checking concurrency)
    // Add a fresh available issue since issue-1 might be logically taken
    db.run(`
      INSERT INTO issues (id, project_id, github_number, title, estimated_complexity, status)
      VALUES ('issue-2', 'proj-1', 2, 'Another fix', 'small', 'available')
    `);
    const result = await findMatchForContributor(db, 'contrib-1');
    expect(result).not.toBeNull();
  });
});
