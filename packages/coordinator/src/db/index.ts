import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

let _db: ReturnType<typeof drizzle> | null = null;
let _sqlite: Database.Database | null = null;

export function getDb(url?: string) {
  if (_db) return _db;
  const dbUrl = url ?? process.env['DATABASE_URL'] ?? './tah.db';
  _sqlite = new Database(dbUrl);
  _sqlite.pragma('journal_mode = WAL');
  _sqlite.pragma('foreign_keys = ON');
  _db = drizzle(_sqlite, { schema });
  return _db;
}

export type Db = ReturnType<typeof getDb>;

export function initSchema() {
  const sqlite = _sqlite;
  if (!sqlite) throw new Error('Call getDb() before initSchema()');

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
      max_concurrent INTEGER NOT NULL DEFAULT 1,
      max_complexity TEXT NOT NULL DEFAULT 'medium',
      trust_score REAL NOT NULL DEFAULT 0,
      available INTEGER NOT NULL DEFAULT 0,
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
  `);

  // Additive column migrations (safe to re-run; errors mean column already exists)
  const addColumns = [
    "ALTER TABLE contributors ADD COLUMN max_complexity TEXT NOT NULL DEFAULT 'medium'",
    "ALTER TABLE tasks ADD COLUMN phase_started_at TEXT",
    "ALTER TABLE projects ADD COLUMN task_types TEXT NOT NULL DEFAULT '[\"code\"]'",
    "ALTER TABLE projects ADD COLUMN trust_threshold REAL NOT NULL DEFAULT 0",
    "ALTER TABLE projects ADD COLUMN claude_md TEXT",
    "ALTER TABLE projects ADD COLUMN github_installation_id TEXT",
  ];
  for (const stmt of addColumns) {
    try { sqlite.exec(stmt); } catch { /* column already exists */ }
  }
}
