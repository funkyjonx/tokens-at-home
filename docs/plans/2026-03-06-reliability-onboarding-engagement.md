# Reliability, Onboarding & Engagement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rearchitect Tokens at Home to eliminate ghost tasks, reduce contributor onboarding to one command, and make contribution feel meaningful.

**Architecture:** Replace the pledge/generic-pledge/watchlist model with a simple contributor-level capacity (`maxComplexity` on the contributor record). Replace bare heartbeats with per-phase progress events stored in a new `task_events` table. Add per-phase timeouts to the stale-task sweep. Add `tah start`, `tah stats`, and `tah project pin/unpin` commands.

**Tech Stack:** TypeScript, Hono, Drizzle ORM + better-sqlite3, Zod, commander.js, vitest

---

## Dependency order

Tasks 1-2 (schema + types) must complete before all others. Tasks 3-5 can proceed after 1-2. Tasks 6-8 (worker) can proceed after 4. Tasks 9-13 (CLI, UI) can proceed after their coordinator counterparts are done.

---

### Task 1: DB Schema — add new columns/tables, remove pledge model

**Files:**
- Modify: `packages/coordinator/src/db/schema.ts`
- Modify: `packages/coordinator/src/db/index.ts`

**Context:** The coordinator uses inline SQL in `initSchema()` as its migration system. Adding new tables/columns is safe to re-run. Existing tables (`pledges`, `generic_pledges`, `watchlist`) are left in the DB for data preservation but removed from the Drizzle schema so application code stops referencing them.

**Step 1: Update `schema.ts`**

Replace the full file with:

```typescript
import { sql } from 'drizzle-orm';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  githubOwner: text('github_owner').notNull(),
  githubRepo: text('github_repo').notNull(),
  registeredBy: text('registered_by').notNull(),
  languages: text('languages').notNull(),
  issueLabel: text('issue_label').notNull().default('tah'),
  claudeMd: text('claude_md'),
  taskTypes: text('task_types').notNull().default('["code"]'),
  maxConcurrent: integer('max_concurrent').notNull().default(3),
  trustThreshold: real('trust_threshold').notNull().default(0),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const contributors = sqliteTable('contributors', {
  id: text('id').primaryKey(),
  githubUsername: text('github_username').notNull().unique(),
  languages: text('languages').notNull(),
  maxConcurrent: integer('max_concurrent').notNull().default(1),
  maxComplexity: text('max_complexity').notNull().default('medium'),
  trustScore: real('trust_score').notNull().default(0),
  available: integer('available', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const projectPins = sqliteTable('project_pins', {
  id: text('id').primaryKey(),
  contributorId: text('contributor_id').notNull().references(() => contributors.id),
  projectId: text('project_id').notNull().references(() => projects.id),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const issues = sqliteTable('issues', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  githubNumber: integer('github_number').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  taskType: text('task_type').notNull().default('code'),
  estimatedComplexity: text('estimated_complexity').notNull().default('small'),
  estimatedTokens: integer('estimated_tokens').notNull().default(8000),
  status: text('status').notNull().default('available'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  issueId: text('issue_id').notNull().references(() => issues.id),
  contributorId: text('contributor_id').notNull().references(() => contributors.id),
  status: text('status').notNull().default('dispatched'),
  phaseStartedAt: text('phase_started_at'),
  tokensUsed: integer('tokens_used'),
  prUrl: text('pr_url'),
  summary: text('summary'),
  errorDetails: text('error_details'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export const taskEvents = sqliteTable('task_events', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id),
  phase: text('phase').notNull(),
  tokensUsed: integer('tokens_used'),
  elapsedMs: integer('elapsed_ms'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const authTokens = sqliteTable('auth_tokens', {
  id: text('id').primaryKey(),
  contributorId: text('contributor_id').notNull().references(() => contributors.id),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});
```

**Step 2: Update `initSchema()` in `db/index.ts`**

Replace the `sqlite.exec(...)` block and `addColumns` array with:

```typescript
export function initSchema(_db: Db) {
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

  // Additive column migrations (safe to re-run)
  const addColumns = [
    "ALTER TABLE contributors ADD COLUMN max_complexity TEXT NOT NULL DEFAULT 'medium'",
    "ALTER TABLE tasks ADD COLUMN phase_started_at TEXT",
    "ALTER TABLE projects ADD COLUMN task_types TEXT NOT NULL DEFAULT '[\"code\"]'",
    "ALTER TABLE projects ADD COLUMN trust_threshold REAL NOT NULL DEFAULT 0",
    "ALTER TABLE projects ADD COLUMN claude_md TEXT",
  ];
  for (const stmt of addColumns) {
    try { sqlite.exec(stmt); } catch { /* column already exists */ }
  }
}
```

**Step 3: Run the build to check for TypeScript errors**

```bash
cd /home/clay/projects/tokens-at-home && pnpm --filter @tah/coordinator build 2>&1 | head -40
```

Expected: build errors referencing removed tables (`pledges`, `genericPledges`, etc.) — that's expected; they'll be fixed in subsequent tasks.

**Step 4: Commit**

```bash
git add packages/coordinator/src/db/schema.ts packages/coordinator/src/db/index.ts
git commit -m "feat(db): add task_events/project_pins, add maxComplexity/phaseStartedAt, drop pledge schema"
```

---

### Task 2: Shared types and schemas

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/schemas.ts`

**Context:** Remove `Pledge`, `GenericPledge`, `WatchlistEntry`, `ContributorAutonomy` from the public API. Add `TaskEvent`, `ProjectPin`. Simplify `Contributor`. Add `ProgressEventSchema`. Update `RegisterContributorSchema` to remove autonomy/cycleResetDate and add maxComplexity.

**Step 1: Update `types.ts`**

Replace the `Contributor`, `Pledge`, `GenericPledge`, `WatchlistEntry`, `ContributorAutonomy` declarations and add the new ones. Full replacement:

```typescript
// Core domain types for Tokens at Home

export type TaskType = 'code' | 'tests' | 'docs' | 'deps' | 'review';
export type IssueComplexity = 'trivial' | 'small' | 'medium' | 'large';

export type IssueStatus =
  | 'available' | 'assigned' | 'in_progress' | 'submitted' | 'merged' | 'rejected' | 'cancelled';

export type TaskStatus =
  | 'dispatched' | 'cloning' | 'working' | 'review' | 'submitting' | 'completed' | 'failed';

// Token estimates by complexity
export const COMPLEXITY_TOKEN_ESTIMATES: Record<IssueComplexity, number> = {
  trivial: 2_000, small: 8_000, medium: 25_000, large: 80_000,
};

export const COMPLEXITY_ORDER: Record<IssueComplexity, number> = {
  trivial: 1, small: 2, medium: 3, large: 4,
};

// Per-phase timeout in milliseconds
export const PHASE_TIMEOUTS_MS: Record<string, number> = {
  dispatched:  2 * 60 * 1000,
  cloning:     3 * 60 * 1000,
  working:    45 * 60 * 1000,
  review:     24 * 60 * 60 * 1000,
  submitting:  5 * 60 * 1000,
};

export function mapGitHubLabelsToComplexity(labels: string[]): IssueComplexity | null {
  for (const label of labels) {
    const l = label.toLowerCase().trim();
    if (/good.first.(issue|contribution)|beginner|starter|first-timer/.test(l)) return 'trivial';
    if (/^(size[/:_\s-]+)?x-?s(mall)?$/.test(l)) return 'trivial';
    if (/^(size[/:_\s-]+)?s(mall)?$/.test(l)) return 'small';
    if (/(effort|complexity)[/:_\s-]*(small|easy|low|minimal|simple|minor)/.test(l)) return 'small';
    if (/^(size[/:_\s-]+)?m(edium)?$/.test(l)) return 'medium';
    if (/(effort|complexity)[/:_\s-]*(medium|moderate|normal)/.test(l)) return 'medium';
    if (/^(size[/:_\s-]+)?x{0,2}l(arge)?$/.test(l)) return 'large';
    if (/(effort|complexity)[/:_\s-]*(large|hard|high|major|complex)/.test(l)) return 'large';
  }
  return null;
}

export interface Project {
  id: string;
  githubOwner: string;
  githubRepo: string;
  registeredBy: string;
  languages: string[];
  issueLabel: string;
  claudeMd?: string;
  taskTypes: TaskType[];
  maxConcurrent: number;
  trustThreshold: number;
  createdAt: string;
}

export interface Contributor {
  id: string;
  githubUsername: string;
  languages: string[];
  maxConcurrent: number;
  maxComplexity: IssueComplexity;
  trustScore: number;
  available: boolean;
  createdAt: string;
}

export interface ProjectPin {
  id: string;
  contributorId: string;
  projectId: string;
  createdAt: string;
}

export interface Issue {
  id: string;
  projectId: string;
  githubNumber: number;
  title: string;
  body: string;
  taskType: TaskType;
  estimatedComplexity: IssueComplexity;
  estimatedTokens: number;
  status: IssueStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  issueId: string;
  contributorId: string;
  status: TaskStatus;
  phaseStartedAt?: string;
  tokensUsed?: number;
  prUrl?: string;
  summary?: string;
  errorDetails?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  phase: string;
  tokensUsed?: number;
  elapsedMs?: number;
  createdAt: string;
}

export interface TaskAssignment {
  task: Task;
  issue: Issue;
  project: Project;
}

export interface HeartbeatResponse {
  ok: boolean;
  cancel?: boolean;
}

export interface CompleteTaskPayload {
  prUrl: string;
  tokensUsed: number;
  summary: string;
}

export interface FailTaskPayload {
  errorDetails: string;
  tokensUsed?: number;
}

export type ActivityEvent =
  | { type: 'project_registered'; ts: string; actor: string; project: string; projectId: string }
  | { type: 'contributor_joined'; ts: string; actor: string }
  | { type: 'task_completed'; ts: string; actor: string; project: string; issueNumber: number; tokensUsed: number; prUrl: string }
  | { type: 'task_failed'; ts: string; actor: string; project: string; issueNumber: number; errorDetails?: string };

export interface LeaderboardEntry {
  rank: number;
  githubUsername: string;
  totalTokensDonated: number;
  tasksCompleted: number;
  successRate: number;
  currentStreak: number;
}

export type LeaderboardPeriod = 'all' | 'month' | 'week';
export type LeaderboardSort = 'tokens' | 'tasks' | 'streak';

export interface ProjectStats {
  totalTasksCompleted: number;
  totalTokensConsumed: number;
  availableIssues: number;
  activeContributors: number;
  topContributors: Array<{ githubUsername: string; tasksCompleted: number }>;
}

export interface PublicContributor {
  id: string;
  githubUsername: string;
  languages: string[];
  trustScore: number;
  tasksCompleted: number;
  totalTokensDonated: number;
  memberSince: string;
}

export interface ContributorStats {
  githubUsername: string;
  memberSince: string;
  allTime: { tasksCompleted: number; tokensDonated: number; successRate: number; rank: number };
  thisMonth: { tasksCompleted: number; tokensDonated: number; rank: number };
  topProjects: Array<{ githubOwner: string; githubRepo: string; tasksCompleted: number }>;
  bestStreak: number;
  currentStreak: number;
}
```

**Step 2: Update `schemas.ts`**

Remove `CreatePledgeSchema`, `AddToWatchlistSchema`, `CreateGenericPledgeSchema`, `ContributorAutonomySchema`. Update `RegisterContributorSchema`. Add `ProgressEventSchema`.

Replace relevant sections:

```typescript
// Remove ContributorAutonomySchema entirely

export const RegisterContributorSchema = z.object({
  githubUsername: githubOwner,
  languages: languageList,
  maxConcurrent: z.number().int().min(1).max(5).default(1),
  maxComplexity: IssueComplexitySchema.default('medium'),
});
export type RegisterContributorInput = z.infer<typeof RegisterContributorSchema>;

export const ProgressEventSchema = z.object({
  phase: z.string().min(1).max(50),
  tokensUsed: z.number().int().min(0).optional(),
  elapsedMs: z.number().int().min(0).optional(),
});
export type ProgressEventInput = z.infer<typeof ProgressEventSchema>;

// Remove CreatePledgeSchema, AddToWatchlistSchema, CreateGenericPledgeSchema

// WorkerConfig — remove autonomy field:
export const WorkerConfigSchema = z.object({
  coordinatorUrl: z.string().url(),
  contributorId: z.string().min(1),
  authToken: z.string().min(1),
  githubUsername: z.string().min(1),
  maxComplexity: IssueComplexitySchema.default('medium'),
  pollIntervalMs: z.number().int().min(5_000).default(30_000),
  workDir: z.string().min(1).optional(),
  logDir: z.string().min(1).optional(),
});
export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;
```

**Step 3: Build shared package**

```bash
cd /home/clay/projects/tokens-at-home && pnpm --filter @tah/shared build 2>&1 | head -30
```

Expected: PASS (no downstream dependencies yet).

**Step 4: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/schemas.ts
git commit -m "feat(shared): simplify contributor model, add TaskEvent/ProjectPin types, add ProgressEventSchema"
```

---

### Task 3: Simplified matching service

**Files:**
- Modify: `packages/coordinator/src/services/matching.ts`
- Modify: `packages/coordinator/src/services/matching.test.ts`

**Context:** The new matching logic has no pledges to check. A contributor matches any available issue where:
1. They are under their `maxConcurrent` limit
2. Their `maxComplexity` >= issue complexity
3. Language overlap exists (soft preference, not hard filter)
4. Optional: if they have project pins, prioritize those projects with a score bonus

**Step 1: Write failing tests first**

In `matching.test.ts`, add tests for the new `findMatchForContributor` behavior:

```typescript
it('matches contributor to issue by language overlap', async () => {
  // contributor languages: ['typescript']
  // project languages: ['typescript']
  // issue: available, small complexity
  // contributor: maxComplexity = 'medium', maxConcurrent = 1, no active tasks
  // expected: returns a match
});

it('returns null when contributor is at maxConcurrent', async () => {
  // contributor has 1 active task, maxConcurrent = 1
  // expected: returns null
});

it('returns null when issue complexity exceeds contributor maxComplexity', async () => {
  // contributor maxComplexity = 'small', issue = 'large'
  // expected: returns null
});

it('scores pinned projects higher than unpinned', async () => {
  // contributor has pin on project A, no pin on project B
  // both have available issues with same complexity
  // expected: project A issue is selected
});
```

Run tests to confirm they fail:
```bash
cd /home/clay/projects/tokens-at-home && pnpm --filter @tah/coordinator test matching 2>&1 | tail -20
```

**Step 2: Rewrite `matching.ts`**

```typescript
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { contributors, issues, projects, tasks, projectPins } from '../db/schema.js';
import type { Issue, Project, Contributor } from '@tah/shared';
import { COMPLEXITY_ORDER } from '@tah/shared';

const TERMINAL_STATUSES = ['completed', 'failed'];

export function scoreMatch(
  contributor: Contributor,
  issue: Issue,
  project: Project,
  isPinned: boolean,
): number | null {
  // Complexity cap
  if (COMPLEXITY_ORDER[issue.estimatedComplexity] > COMPLEXITY_ORDER[contributor.maxComplexity]) return null;

  // Language overlap (0-1)
  const contributorLangs = new Set(contributor.languages.map((l) => l.toLowerCase()));
  const projectLangs = project.languages.map((l) => l.toLowerCase());
  const overlap = projectLangs.filter((l) => contributorLangs.has(l)).length;
  const langScore = projectLangs.length > 0 ? overlap / projectLangs.length : 0.5;

  // Prefer more complex issues (more meaningful work)
  const complexityScore = COMPLEXITY_ORDER[issue.estimatedComplexity] / 4;

  // Pinned project bonus
  const pinBonus = isPinned ? 0.3 : 0;

  return langScore * 0.5 + complexityScore * 0.2 + pinBonus;
}

export async function findMatchForContributor(
  db: Db,
  contributorId: string,
): Promise<{ issueId: string; score: number } | null> {
  const contributor = await db
    .select()
    .from(contributors)
    .where(eq(contributors.id, contributorId))
    .get();

  if (!contributor || !contributor.available) return null;

  // Check concurrency limit
  const activeTasks = await db
    .select({ status: tasks.status })
    .from(tasks)
    .where(eq(tasks.contributorId, contributorId))
    .all();
  const activeCount = activeTasks.filter((t) => !TERMINAL_STATUSES.includes(t.status)).length;
  if (activeCount >= contributor.maxConcurrent) return null;

  // Load available issues and their projects
  const availableIssues = await db
    .select()
    .from(issues)
    .where(eq(issues.status, 'available'))
    .all();

  if (availableIssues.length === 0) return null;

  const allProjects = await db.select().from(projects).all();
  const projectMap = new Map(allProjects.map((p) => [p.id, p]));

  // Load pins for this contributor
  const pins = await db
    .select({ projectId: projectPins.projectId })
    .from(projectPins)
    .where(eq(projectPins.contributorId, contributorId))
    .all();
  const pinnedProjectIds = new Set(pins.map((p) => p.projectId));

  const contributorTyped: Contributor = {
    ...contributor,
    languages: JSON.parse(contributor.languages) as string[],
    maxComplexity: contributor.maxComplexity as Contributor['maxComplexity'],
    available: Boolean(contributor.available),
  };

  const candidates: Array<{ issueId: string; score: number }> = [];

  for (const issue of availableIssues) {
    const project = projectMap.get(issue.projectId);
    if (!project) continue;

    const projectTyped = {
      ...project,
      languages: JSON.parse(project.languages) as string[],
      taskTypes: JSON.parse(project.taskTypes) as string[],
    } as unknown as Project;

    const isPinned = pinnedProjectIds.has(project.id);
    const score = scoreMatch(contributorTyped, issue as unknown as Issue, projectTyped, isPinned);
    if (score !== null) {
      candidates.push({ issueId: issue.id, score });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]!;
}
```

**Step 3: Run tests**

```bash
cd /home/clay/projects/tokens-at-home && pnpm --filter @tah/coordinator test matching 2>&1 | tail -20
```

Expected: all matching tests pass.

**Step 4: Commit**

```bash
git add packages/coordinator/src/services/matching.ts packages/coordinator/src/services/matching.test.ts
git commit -m "feat(matching): simplify matching — no pledges, use contributor maxComplexity + project pins"
```

---

### Task 4: Progress endpoint + updated task routes + per-phase stale sweep

**Files:**
- Modify: `packages/coordinator/src/routes/tasks.ts`
- Modify: `packages/coordinator/src/routes/api.test.ts` (update test DDL)

**Context:** Add `POST /tasks/:id/progress` that stores a `task_events` row and updates `tasks.status` + `tasks.phase_started_at`. Update `abandonStaleTasks` to use per-phase timeouts from `PHASE_TIMEOUTS_MS` instead of a single heartbeat window. Remove `pledgeId` from task creation. Update the `GET /tasks/next` transaction to not reference pledge tables.

**Step 1: Update test DDL in `api.test.ts`**

Find the `createTestDb` function and update its `sqlite.exec(...)` to match the new schema (add `task_events`, `project_pins`; remove `pledges`, `watchlist`, `generic_pledges`; update `tasks` to remove `pledge_id`/`last_heartbeat_at`, add `phase_started_at`; update `contributors` to remove `autonomy`/`cycle_reset_date`, add `max_complexity`). Also add a `registerContributor` helper that uses the new schema.

The new DDL for `createTestDb`:

```typescript
function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, github_owner TEXT NOT NULL, github_repo TEXT NOT NULL,
      registered_by TEXT NOT NULL, languages TEXT NOT NULL DEFAULT '[]',
      issue_label TEXT NOT NULL DEFAULT 'tah', claude_md TEXT,
      task_types TEXT NOT NULL DEFAULT '["code"]',
      max_concurrent INTEGER NOT NULL DEFAULT 3,
      trust_threshold REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS contributors (
      id TEXT PRIMARY KEY, github_username TEXT NOT NULL UNIQUE,
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
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      github_number INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
      task_type TEXT NOT NULL DEFAULT 'code',
      estimated_complexity TEXT NOT NULL DEFAULT 'small',
      estimated_tokens INTEGER NOT NULL DEFAULT 8000,
      status TEXT NOT NULL DEFAULT 'available',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES issues(id),
      contributor_id TEXT NOT NULL REFERENCES contributors(id),
      status TEXT NOT NULL DEFAULT 'dispatched',
      phase_started_at TEXT, tokens_used INTEGER, pr_url TEXT,
      summary TEXT, error_details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS task_events (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
      phase TEXT NOT NULL, tokens_used INTEGER, elapsed_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS auth_tokens (
      id TEXT PRIMARY KEY, contributor_id TEXT NOT NULL REFERENCES contributors(id),
      token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}
```

**Step 2: Write failing test for progress endpoint**

```typescript
it('POST /tasks/:id/progress records phase event and updates task status', async () => {
  // register contributor, create issue+task, then POST progress
  const res = await app.request(`/tasks/${taskId}/progress`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ phase: 'working', tokensUsed: 5000, elapsedMs: 60000 }),
  });
  expect(res.status).toBe(200);
  // verify task status updated to 'working'
  // verify task_events row inserted
});
```

**Step 3: Rewrite `tasks.ts`**

Key changes:
- Remove `pledgeId` from task insert in `GET /tasks/next`
- Remove `findMatchForContributor` call's `pledgeId` usage (new signature returns `{ issueId, score }`)
- Add `POST /:id/progress` handler
- Rewrite `abandonStaleTasks` with per-phase timeouts

```typescript
// POST /:id/progress
app.post('/:id/progress', async (c) => {
  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token) return c.json({ error: 'Unauthorized' }, 401);
  const contributor = await getContributorFromToken(db, token);
  if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

  const task = await db.select().from(tasks).where(eq(tasks.id, c.req.param('id'))).get();
  if (!task) return c.json({ error: 'Not found' }, 404);
  if (task.contributorId !== contributor.id) return c.json({ error: 'Forbidden' }, 403);

  const body = await c.req.json();
  const parsed = ProgressEventSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const now = new Date().toISOString();
  const eventId = randomBytes(8).toString('hex');

  await db.insert(taskEvents).values({
    id: eventId,
    taskId: task.id,
    phase: parsed.data.phase,
    tokensUsed: parsed.data.tokensUsed ?? null,
    elapsedMs: parsed.data.elapsedMs ?? null,
  });

  await db.update(tasks).set({
    status: parsed.data.phase as TaskStatus,
    phaseStartedAt: now,
    updatedAt: now,
  }).where(eq(tasks.id, task.id));

  return c.json({ ok: true });
});
```

```typescript
// Updated abandonStaleTasks
export async function abandonStaleTasks(db: Db): Promise<number> {
  const activeStatuses = ['dispatched', 'cloning', 'working', 'review', 'submitting'];
  const activeTasks = await db
    .select()
    .from(tasks)
    .where(sql`${tasks.status} IN (${activeStatuses.map(() => '?').join(',')})`)
    .all();

  const now = Date.now();
  let abandoned = 0;

  for (const task of activeTasks) {
    const timeout = PHASE_TIMEOUTS_MS[task.status];
    if (!timeout || !task.phaseStartedAt) continue;
    const elapsed = now - new Date(task.phaseStartedAt).getTime();
    if (elapsed <= timeout) continue;

    const timestamp = new Date().toISOString();
    await db.update(tasks).set({
      status: 'failed',
      errorDetails: `Phase '${task.status}' timed out after ${Math.round(elapsed / 60000)}m`,
      updatedAt: timestamp,
    }).where(eq(tasks.id, task.id));

    await db.update(issues).set({ status: 'available', updatedAt: timestamp })
      .where(eq(issues.id, task.issueId));

    abandoned++;
  }

  return abandoned;
}
```

Note: Import `PHASE_TIMEOUTS_MS` from `@tah/shared`, `taskEvents` from schema, `ProgressEventSchema` from `@tah/shared`.

**Step 4: Run tests**

```bash
cd /home/clay/projects/tokens-at-home && pnpm --filter @tah/coordinator test 2>&1 | tail -30
```

Expected: all passing.

**Step 5: Commit**

```bash
git add packages/coordinator/src/routes/tasks.ts packages/coordinator/src/routes/api.test.ts
git commit -m "feat(tasks): add progress endpoint, per-phase stale timeouts, remove pledge references"
```

---

### Task 5: Simplified contributor routes + project pin endpoints

**Files:**
- Modify: `packages/coordinator/src/routes/contributors.ts`

**Context:** Remove all pledge, generic-pledge, and watchlist endpoint handlers. Simplify registration to use `maxComplexity` instead of `autonomy`/`cycleResetDate`. Add `POST /me/pins`, `DELETE /me/pins/:projectId`, `GET /me/pins`.

**Step 1: Write failing tests for pin endpoints**

```typescript
it('POST /contributors/me/pins adds a project pin', async () => {
  const res = await app.request('/contributors/me/pins', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: project.id }),
  });
  expect(res.status).toBe(201);
  const body = await res.json() as ProjectPin;
  expect(body.projectId).toBe(project.id);
});

it('DELETE /contributors/me/pins/:projectId removes pin', async () => { ... });
it('GET /contributors/me/pins lists pins', async () => { ... });
```

**Step 2: Rewrite `contributors.ts`**

Remove imports of `pledges`, `watchlist`, `genericPledges` from schema. Remove imports of `CreatePledgeSchema`, `AddToWatchlistSchema`, `CreateGenericPledgeSchema`. Add import of `projectPins`.

Remove these route handlers entirely:
- `POST /me/pledges`
- `GET /me/pledges`
- `DELETE /me/pledges/:pledgeId`
- `POST /me/watchlist`
- `DELETE /me/watchlist/:projectId`
- `GET /me/watchlist`
- `POST /me/generic-pledges`
- `GET /me/generic-pledges`
- `DELETE /me/generic-pledges/:pledgeId`

Update `POST /` (registration) to use new schema:
```typescript
await db.insert(contributors).values({
  id,
  githubUsername: input.githubUsername,
  languages: JSON.stringify(input.languages),
  maxConcurrent: input.maxConcurrent,
  maxComplexity: input.maxComplexity,
  trustScore: 0,
  available: false,
});
```

Add pin endpoints:
```typescript
// POST /me/pins
app.post('/me/pins', async (c) => {
  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token) return c.json({ error: 'Unauthorized' }, 401);
  const contributor = await getContributorFromToken(db, token);
  if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

  const body = await c.req.json() as { projectId?: string };
  if (!body.projectId) return c.json({ error: 'projectId required' }, 400);

  const project = await db.select({ id: projects.id }).from(projects)
    .where(eq(projects.id, body.projectId)).get();
  if (!project) return c.json({ error: 'Project not found' }, 404);

  const existing = await db.select({ id: projectPins.id }).from(projectPins)
    .where(and(eq(projectPins.contributorId, contributor.id), eq(projectPins.projectId, body.projectId)))
    .get();
  if (existing) return c.json({ error: 'Already pinned' }, 409);

  const id = randomBytes(8).toString('hex');
  await db.insert(projectPins).values({ id, contributorId: contributor.id, projectId: body.projectId });
  const pin = await db.select().from(projectPins).where(eq(projectPins.id, id)).get();
  return c.json(pin, 201);
});

// DELETE /me/pins/:projectId
app.delete('/me/pins/:projectId', async (c) => {
  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token) return c.json({ error: 'Unauthorized' }, 401);
  const contributor = await getContributorFromToken(db, token);
  if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

  const pin = await db.select({ id: projectPins.id }).from(projectPins)
    .where(and(eq(projectPins.contributorId, contributor.id), eq(projectPins.projectId, c.req.param('projectId'))))
    .get();
  if (!pin) return c.json({ error: 'Not found' }, 404);

  await db.delete(projectPins).where(eq(projectPins.id, pin.id));
  return c.json({ ok: true });
});

// GET /me/pins
app.get('/me/pins', async (c) => {
  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token) return c.json({ error: 'Unauthorized' }, 401);
  const contributor = await getContributorFromToken(db, token);
  if (!contributor) return c.json({ error: 'Unauthorized' }, 401);

  const pins = await db
    .select({
      id: projectPins.id, projectId: projectPins.projectId, createdAt: projectPins.createdAt,
      githubOwner: projects.githubOwner, githubRepo: projects.githubRepo,
    })
    .from(projectPins)
    .innerJoin(projects, eq(projectPins.projectId, projects.id))
    .where(eq(projectPins.contributorId, contributor.id))
    .all();

  return c.json(pins);
});
```

Update `deserializeContributor` to remove autonomy/cycleResetDate:
```typescript
function deserializeContributor(c: typeof contributors.$inferSelect) {
  return {
    ...c,
    languages: JSON.parse(c.languages) as string[],
    available: Boolean(c.available),
  };
}
```

**Step 3: Run tests**

```bash
cd /home/clay/projects/tokens-at-home && pnpm --filter @tah/coordinator test 2>&1 | tail -30
```

**Step 4: Commit**

```bash
git add packages/coordinator/src/routes/contributors.ts
git commit -m "feat(contributors): simplify registration, add project pin endpoints, remove pledge/watchlist routes"
```

---

### Task 6: Update coordinator's index.ts route registration

**Files:**
- Modify: `packages/coordinator/src/index.ts`

**Context:** Remove `abandonStaleTasks` import detail — ensure it still imports from tasks. No functional changes needed; this task verifies the coordinator builds and the stale sweep still runs.

**Step 1: Build and verify**

```bash
cd /home/clay/projects/tokens-at-home && pnpm --filter @tah/coordinator build 2>&1 | head -40
```

Expected: clean build. Fix any remaining TypeScript errors from tasks 1-5 that appear here (e.g. unused imports in index.ts).

**Step 2: Run all coordinator tests**

```bash
pnpm --filter @tah/coordinator test 2>&1 | tail -20
```

Expected: all pass.

**Step 3: Commit**

```bash
git add packages/coordinator/src/
git commit -m "fix(coordinator): clean up remaining pledge references, verify build"
```

---

### Task 7: Worker — replace heartbeat with progress events

**Files:**
- Modify: `packages/worker/src/poller.ts`

**Context:** Replace `sendHeartbeat` with `sendProgress`. Remove `getPledges` and `getGenericPledges`. Add `getContributorStats` for the new `tah stats` command.

**Step 1: Rewrite `poller.ts`**

```typescript
import type { WorkerConfig, TaskAssignment, ContributorStats } from '@tah/shared';

export class CoordinatorClient {
  constructor(private readonly config: WorkerConfig) {}

  private get headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.config.authToken}`,
      'Content-Type': 'application/json',
    };
  }

  private url(path: string): string {
    return `${this.config.coordinatorUrl}${path}`;
  }

  async getNextTask(): Promise<TaskAssignment | null> {
    const res = await fetch(this.url('/tasks/next'), { headers: this.headers });
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`GET /tasks/next failed: ${res.status}`);
    return res.json() as Promise<TaskAssignment>;
  }

  async sendProgress(taskId: string, phase: string, tokensUsed?: number, elapsedMs?: number): Promise<void> {
    const res = await fetch(this.url(`/tasks/${taskId}/progress`), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ phase, tokensUsed, elapsedMs }),
    });
    if (!res.ok) throw new Error(`Progress update failed: ${res.status}`);
  }

  async completeTask(taskId: string, prUrl: string, tokensUsed: number, summary: string): Promise<void> {
    const res = await fetch(this.url(`/tasks/${taskId}/complete`), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ prUrl, tokensUsed, summary }),
    });
    if (!res.ok) throw new Error(`Complete task failed: ${res.status}`);
  }

  async failTask(taskId: string, errorDetails: string, tokensUsed?: number): Promise<void> {
    const res = await fetch(this.url(`/tasks/${taskId}/fail`), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ errorDetails, tokensUsed }),
    });
    if (!res.ok) throw new Error(`Fail task failed: ${res.status}`);
  }

  async setAvailable(available: boolean): Promise<void> {
    const res = await fetch(this.url('/contributors/me/available'), {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify({ available }),
    });
    if (!res.ok) throw new Error(`Set available failed: ${res.status}`);
  }

  async getPins(): Promise<Array<{ projectId: string; githubOwner: string; githubRepo: string }>> {
    const res = await fetch(this.url('/contributors/me/pins'), { headers: this.headers });
    if (!res.ok) throw new Error(`Get pins failed: ${res.status}`);
    return res.json() as Promise<Array<{ projectId: string; githubOwner: string; githubRepo: string }>>;
  }

  async addPin(projectId: string): Promise<void> {
    const res = await fetch(this.url('/contributors/me/pins'), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ projectId }),
    });
    if (!res.ok) throw new Error(`Add pin failed: ${res.status}`);
  }

  async removePin(projectId: string): Promise<void> {
    const res = await fetch(this.url(`/contributors/me/pins/${projectId}`), {
      method: 'DELETE',
      headers: this.headers,
    });
    if (!res.ok) throw new Error(`Remove pin failed: ${res.status}`);
  }
}
```

**Step 2: Build worker**

```bash
pnpm --filter @tah/worker build 2>&1 | head -30
```

Expected: errors in `index.ts` referencing `sendHeartbeat`/`getPledges` — fix in next task.

**Step 3: Commit**

```bash
git add packages/worker/src/poller.ts
git commit -m "feat(worker): replace heartbeat with sendProgress, add pin methods, remove pledge methods"
```

---

### Task 8: Worker loop — fix cleanup guarantee, use progress events, extend execution timeout

**Files:**
- Modify: `packages/worker/src/index.ts`
- Modify: `packages/worker/src/executor.ts`

**Context:** The worker loop sends progress events instead of heartbeats. The progress interval fires every 60s with current phase + token count from the execution result. The cleanup `finally` block becomes unconditional. The Claude execution timeout extends from 10 to 40 minutes.

**Step 1: Update `executor.ts`** — extend timeout

Find the line:
```typescript
const timeout = setTimeout(() => {
  proc.kill();
  reject(new Error('Claude timed out after 10 minutes'));
}, 10 * 60 * 1000);
```

Change to 40 minutes:
```typescript
const timeout = setTimeout(() => {
  proc.kill();
  reject(new Error('Claude timed out after 40 minutes'));
}, 40 * 60 * 1000);
```

**Step 2: Update `index.ts`**

Replace the worker loop with the new version. Key changes:
- Remove `currentHeartbeatTimer` — replace with `currentProgressTimer`
- Progress timer calls `client.sendProgress(task.id, currentPhase, currentTokens, elapsed)`
- Track `currentPhase` and `currentTokens` as mutable variables updated by the execution
- Cleanup moves to unconditional `finally` using `taskId` (not `result.taskWorkDir`)
- Remove `client.getPledges()` / `client.getGenericPledges()` check on startup
- Update warning message to reference `tah project pin`

```typescript
let currentProgressTimer: ReturnType<typeof setInterval> | null = null;

// In the task loop, replace heartbeat setup:
let currentPhase = 'working';
let currentTokens = 0;
const taskStartMs = Date.now();

currentProgressTimer = setInterval(async () => {
  try {
    await client.sendProgress(task.id, currentPhase, currentTokens, Date.now() - taskStartMs);
  } catch (err) {
    console.error('[worker] Progress update error:', err);
  }
}, 60_000);

// After executeTask completes, update currentTokens:
currentTokens = result?.claudeOutput?.tokensUsed ?? 0;

// Cleanup: move to unconditional finally using taskId
} finally {
  if (currentProgressTimer) {
    clearInterval(currentProgressTimer);
    currentProgressTimer = null;
  }
  // Clean up work directory unconditionally
  const taskWorkDir = join(workDir, task.id);
  try {
    rmSync(taskWorkDir, { recursive: true, force: true });
  } catch { /* non-fatal */ }
}
```

Remove startup pledge check. Update empty-poll warning:
```typescript
console.log(`[worker] Waiting for tasks... (${emptyPolls} polls — pin projects with \`tah project pin <owner/repo>\`)`);
```

Update phase progress reporting. After `client.sendProgress` calls for explicit transitions (cloning, working, etc.), add the phase to the terminal output:

```typescript
// Phase transition logging
console.log(`[1/4] Cloning...`);
await client.sendProgress(task.id, 'cloning');
// ... clone logic ...
console.log(`      done (${Math.round((Date.now() - taskStartMs) / 1000)}s)`);

console.log(`[2/4] Running Claude...`);
currentPhase = 'working';
await client.sendProgress(task.id, 'working', 0, Date.now() - taskStartMs);
result = await executeTask(task, issue, project, workDir, logDir);
currentTokens = result?.claudeOutput?.tokensUsed ?? 0;
```

After task completion, print running total:
```typescript
const meRes = await fetch(`${config.coordinatorUrl}/contributors/me`, {
  headers: { Authorization: `Bearer ${config.authToken}` },
});
if (meRes.ok) {
  // fetch total stats inline for the completion message
}
console.log(`[ok]  Done -> ${pr.prUrl}`);
console.log(`      ${fmtNum(result.claudeOutput.tokensUsed)} tokens donated`);
```

**Step 3: Build worker**

```bash
pnpm --filter @tah/worker build 2>&1 | head -30
```

Expected: clean build.

**Step 4: Commit**

```bash
git add packages/worker/src/index.ts packages/worker/src/executor.ts
git commit -m "feat(worker): use progress events, fix cleanup guarantee, extend Claude timeout to 40m"
```

---

### Task 9: `tah start` command

**Files:**
- Create: `packages/cli/src/commands/start.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/worker/src/config.ts` (add `saveConfig`)
- Modify: `packages/cli/src/config.ts` (fix error message to reference `tah start`)

**Context:** `tah start` detects whether the user is already registered (config exists), registers if not (interactive prompts), then immediately starts the worker. This replaces the multi-step `register → pledge → pledge-any → start` flow.

**Step 1: Add `saveConfig` to `packages/worker/src/config.ts`**

```typescript
import { writeFileSync, mkdirSync } from 'fs';

export function saveConfig(config: WorkerConfig, configPath = DEFAULT_CONFIG_PATH): void {
  const dir = configPath.replace(/\/[^/]+$/, '');
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}
```

**Step 2: Create `packages/cli/src/commands/start.ts`**

```typescript
import { Command } from 'commander';
import { createInterface } from 'readline';
import { existsSync } from 'fs';
import { TahApiClient } from '../api.js';
import { loadConfig, saveConfig, DEFAULT_CONFIG_PATH, DEFAULT_COORDINATOR_URL } from '../../../worker/src/config.js';
import { startWorker } from '../../../worker/src/index.js';

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

export function startCommand(): Command {
  return new Command('start')
    .description('Register (if needed) and start the worker')
    .option('--coordinator <url>', 'coordinator URL', DEFAULT_COORDINATOR_URL)
    .option('--config <path>', 'config file path', DEFAULT_CONFIG_PATH)
    .action(async (opts) => {
      // If already configured, just start
      if (existsSync(opts.config)) {
        console.log('Config found. Starting worker...');
        await startWorker(opts.config);
        return;
      }

      console.log('\n  Tokens at Home — donate your Claude capacity to open source\n');

      const rl = createInterface({ input: process.stdin, output: process.stdout });

      const username = (await prompt(rl, '  GitHub username: ')).trim();
      const langsRaw = (await prompt(rl, '  Languages (comma-separated, e.g. typescript,python): ')).trim();
      const languages = langsRaw.split(',').map((l) => l.trim().toLowerCase()).filter(Boolean);
      const maxConcurrentStr = (await prompt(rl, '  Max concurrent tasks [1]: ')).trim();
      const maxConcurrent = parseInt(maxConcurrentStr || '1', 10) || 1;
      const maxComplexity = ((await prompt(rl, '  Max complexity (trivial/small/medium/large) [medium]: ')).trim() || 'medium') as 'trivial' | 'small' | 'medium' | 'large';

      rl.close();

      const api = new TahApiClient({ coordinatorUrl: opts.coordinator, authToken: '' });
      const { contributor, token } = await api.registerContributor({
        githubUsername: username,
        languages,
        maxConcurrent,
        maxComplexity,
      });

      const config = {
        coordinatorUrl: opts.coordinator,
        contributorId: contributor.id,
        authToken: token,
        githubUsername: username,
        maxComplexity,
        pollIntervalMs: 30_000,
      };

      saveConfig(config, opts.config);

      console.log(`\n  Registered as @${username}. Starting worker...`);
      console.log('  Watching for tasks — contributing to any matching open source project.');
      console.log('  To focus on specific projects: tah project pin <owner/repo>\n');

      await startWorker(opts.config);
    });
}
```

**Step 3: Register command in `index.ts`**

```typescript
import { startCommand } from './commands/start.js';
// ...
program.addCommand(startCommand());
```

**Step 4: Update error message in `packages/worker/src/config.ts`**

Change:
```typescript
`Config not found at ${configPath}. Run 'tah contributor register' first.`
```
To:
```typescript
`Config not found at ${configPath}. Run 'tah start' first.`
```

**Step 5: Build CLI**

```bash
pnpm --filter @tah/cli build 2>&1 | head -30
```

**Step 6: Commit**

```bash
git add packages/cli/src/commands/start.ts packages/cli/src/index.ts packages/worker/src/config.ts
git commit -m "feat(cli): add tah start command — single-step onboarding + worker launch"
```

---

### Task 10: `tah stats` command

**Files:**
- Create: `packages/cli/src/commands/stats.ts`
- Modify: `packages/cli/src/api.ts` (add `getStats` and `getContributorStats`)
- Modify: `packages/cli/src/index.ts`

**Context:** Add a `GET /contributors/:username/stats` endpoint to the coordinator and a `tah stats [username]` CLI command.

**Step 1: Add stats endpoint to coordinator**

In `packages/coordinator/src/routes/contributors.ts`, add:

```typescript
app.get('/:username/stats', async (c) => {
  const { username } = c.req.param();
  const contributor = await db.select().from(contributors)
    .where(eq(contributors.githubUsername, username)).get();
  if (!contributor) return c.json({ error: 'Not found' }, 404);

  // All-time task stats
  const allTasks = await db.select({
    status: tasks.status, tokensUsed: tasks.tokensUsed,
    createdAt: tasks.createdAt, issueId: tasks.issueId,
  }).from(tasks).where(eq(tasks.contributorId, contributor.id)).all();

  const completed = allTasks.filter((t) => t.status === 'completed');
  const failed = allTasks.filter((t) => t.status === 'failed');
  const totalTokens = completed.reduce((s, t) => s + (t.tokensUsed ?? 0), 0);
  const successRate = (completed.length + failed.length) > 0
    ? completed.length / (completed.length + failed.length) : 0;

  // This month
  const monthAgo = new Date(); monthAgo.setDate(monthAgo.getDate() - 30);
  const thisMonthCompleted = completed.filter((t) => new Date(t.createdAt) >= monthAgo);
  const thisMonthTokens = thisMonthCompleted.reduce((s, t) => s + (t.tokensUsed ?? 0), 0);

  // All-time rank (by tokens)
  const allStats = await db.select({
    contributorId: tasks.contributorId,
    tokens: sql<number>`sum(coalesce(${tasks.tokensUsed}, 0))`,
  }).from(tasks).where(eq(tasks.status, 'completed')).groupBy(tasks.contributorId)
    .orderBy(sql`tokens DESC`).all();
  const allTimeRank = allStats.findIndex((r) => r.contributorId === contributor.id) + 1;

  // This month rank
  const monthStats = await db.select({
    contributorId: tasks.contributorId,
    tokens: sql<number>`sum(coalesce(${tasks.tokensUsed}, 0))`,
  }).from(tasks).where(and(eq(tasks.status, 'completed'), sql`${tasks.createdAt} >= datetime('now', '-30 days')`))
    .groupBy(tasks.contributorId).orderBy(sql`tokens DESC`).all();
  const monthRank = monthStats.findIndex((r) => r.contributorId === contributor.id) + 1;

  // Top projects
  const projectTaskCounts = new Map<string, number>();
  for (const t of completed) {
    const issue = await db.select({ projectId: issues.projectId }).from(issues)
      .where(eq(issues.id, t.issueId)).get();
    if (issue) projectTaskCounts.set(issue.projectId, (projectTaskCounts.get(issue.projectId) ?? 0) + 1);
  }
  const topProjectIds = [...projectTaskCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const topProjects = await Promise.all(topProjectIds.map(async ([pid, count]) => {
    const p = await db.select({ githubOwner: projects.githubOwner, githubRepo: projects.githubRepo })
      .from(projects).where(eq(projects.id, pid)).get();
    return p ? { ...p, tasksCompleted: count } : null;
  }));

  // Streaks (reuse computeStreak logic from leaderboard route)
  const dates = completed.map((t) => t.createdAt);
  const uniqueDays = [...new Set(dates.map((d) => d.substring(0, 10)))].sort().reverse();
  // ... streak computation (copy from ui.ts leaderboard section)

  return c.json({
    githubUsername: contributor.githubUsername,
    memberSince: contributor.createdAt,
    allTime: { tasksCompleted: completed.length, tokensDonated: totalTokens, successRate, rank: allTimeRank },
    thisMonth: { tasksCompleted: thisMonthCompleted.length, tokensDonated: thisMonthTokens, rank: monthRank },
    topProjects: topProjects.filter(Boolean),
    bestStreak: 0, // compute similarly to leaderboard
    currentStreak: 0,
  });
});
```

**Step 2: Create `packages/cli/src/commands/stats.ts`**

```typescript
import { Command } from 'commander';
import { TahApiClient } from '../api.js';
import { loadConfig } from '../config.js';
import type { ContributorStats } from '@tah/shared';

function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

export function statsCommand(): Command {
  return new Command('stats')
    .description('Show contribution stats')
    .argument('[username]', 'GitHub username (defaults to your own)')
    .action(async (username?: string) => {
      const config = loadConfig();
      const api = new TahApiClient(config);

      const target = username ?? config.githubUsername;
      if (!target) {
        console.error('Username not found in config. Run tah start first.');
        process.exit(1);
      }

      const stats = await api.getContributorStats(target) as ContributorStats;

      const since = stats.memberSince.substring(0, 10);
      const rankStr = (r: number) => r > 0 ? `Rank #${r}` : 'Unranked';

      console.log(`\n  ${target} — contributing since ${since}\n`);
      console.log(`  ${'All time'.padEnd(20)}  This month`);
      console.log(`  ${'─'.repeat(19)}  ${'─'.repeat(19)}`);
      console.log(`  ${fmtNum(stats.allTime.tasksCompleted).padEnd(5)} tasks            ${fmtNum(stats.thisMonth.tasksCompleted)} tasks`);
      console.log(`  ${fmtNum(stats.allTime.tokensDonated).padEnd(12)} tokens  ${fmtNum(stats.thisMonth.tokensDonated)} tokens`);
      console.log(`  ${(Math.round(stats.allTime.successRate * 100) + '% success').padEnd(20)}  ${rankStr(stats.thisMonth.rank)}`);
      console.log(`  ${rankStr(stats.allTime.rank)}`);
      if (stats.topProjects.length > 0) {
        const top = stats.topProjects.map((p) => `${p.githubOwner}/${p.githubRepo} (${p.tasksCompleted})`).join('  ·  ');
        console.log(`\n  Top projects: ${top}`);
      }
      if (stats.bestStreak > 0) {
        console.log(`  Best streak: ${stats.bestStreak}d  ·  Current: ${stats.currentStreak}d`);
      }
      console.log();
    });
}
```

**Step 3: Register command**

```typescript
import { statsCommand } from './commands/stats.js';
program.addCommand(statsCommand());
```

**Step 4: Add `getContributorStats` to `api.ts`**

```typescript
async getContributorStats(username: string): Promise<ContributorStats> {
  const res = await this.get(`/contributors/${encodeURIComponent(username)}/stats`);
  return res.json();
}
```

**Step 5: Build and commit**

```bash
pnpm --filter @tah/cli build 2>&1 | head -20
git add packages/cli/src/commands/stats.ts packages/cli/src/api.ts packages/cli/src/index.ts packages/coordinator/src/routes/contributors.ts
git commit -m "feat: add tah stats command and GET /contributors/:username/stats endpoint"
```

---

### Task 11: `tah project pin` and `tah project unpin`

**Files:**
- Modify: `packages/cli/src/commands/project.ts`
- Modify: `packages/cli/src/api.ts`

**Context:** Add `pin <owner/repo>` and `unpin <owner/repo>` subcommands to the existing `project` command. These resolve the owner/repo to a project ID then call the pin endpoints.

**Step 1: Add `pinProject` and `unpinProject` to `api.ts`**

```typescript
async findProjectByRepo(owner: string, repo: string): Promise<{ id: string } | null> {
  const res = await this.get(`/projects?q=${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  const results = await res.json() as Array<{ id: string; githubOwner: string; githubRepo: string }>;
  return results.find((p) => p.githubOwner === owner && p.githubRepo === repo) ?? null;
}

async pinProject(projectId: string): Promise<void> {
  await this.post('/contributors/me/pins', { projectId });
}

async unpinProject(projectId: string): Promise<void> {
  await this.delete(`/contributors/me/pins/${projectId}`);
}
```

**Step 2: Add pin/unpin subcommands to `project.ts`**

```typescript
cmd
  .command('pin <owner/repo>')
  .description('Pin a project — worker will prioritize its issues')
  .action(async (ownerRepo: string) => {
    const [owner, repo] = ownerRepo.split('/');
    if (!owner || !repo) { console.error('Format: tah project pin owner/repo'); process.exit(1); }
    const api = new TahApiClient(loadConfig());
    const project = await api.findProjectByRepo(owner, repo);
    if (!project) { console.error(`Project ${ownerRepo} not found. Register it with: tah project add ${ownerRepo}`); process.exit(1); }
    await api.pinProject(project.id);
    console.log(`Pinned ${ownerRepo}. Worker will prioritize this project's issues.`);
  });

cmd
  .command('unpin <owner/repo>')
  .description('Remove a project pin')
  .action(async (ownerRepo: string) => {
    const [owner, repo] = ownerRepo.split('/');
    if (!owner || !repo) { console.error('Format: tah project unpin owner/repo'); process.exit(1); }
    const api = new TahApiClient(loadConfig());
    const project = await api.findProjectByRepo(owner, repo);
    if (!project) { console.error(`Project ${ownerRepo} not found.`); process.exit(1); }
    await api.unpinProject(project.id);
    console.log(`Unpinned ${ownerRepo}.`);
  });
```

**Step 3: Build and commit**

```bash
pnpm --filter @tah/cli build 2>&1 | head -20
git add packages/cli/src/commands/project.ts packages/cli/src/api.ts
git commit -m "feat(cli): add tah project pin/unpin commands"
```

---

### Task 12: PR attribution — link contributor profile

**Files:**
- Modify: `packages/worker/src/pr.ts`

**Context:** Update the PR body to link to the contributor's profile on tokens-at-home.fly.dev and include their stats.

**Step 1: Update `createPr` in `pr.ts`**

Replace the `prBody` construction:

```typescript
const profileUrl = `https://tokens-at-home.fly.dev/ui/contributors/${contributorUsername}`;

const prBody = [
  `Closes #${issue.githubNumber}`,
  '',
  '## Summary',
  summary,
  '',
  '---',
  `Contributed by [@${contributorUsername}](${profileUrl}) via [Tokens at Home](https://tokens-at-home.fly.dev)`,
].join('\n');
```

**Step 2: Commit**

```bash
git add packages/worker/src/pr.ts
git commit -m "feat(worker): link contributor profile in PR attribution"
```

---

### Task 13: Web UI — contributor profile page + live task feed

**Files:**
- Modify: `packages/coordinator/src/routes/ui.ts`

**Context:** Add `/ui/contributors/:username` profile page. Update the dashboard's "Recent Activity" to show in-progress tasks (from `task_events`) alongside completed tasks — making the platform feel alive.

**Step 1: Add contributor profile route**

Add before `return app;` in `uiRoutes`:

```typescript
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
  const successRate = (allTasks.filter((t) => ['completed','failed'].includes(t.status)).length > 0)
    ? completed.length / allTasks.filter((t) => ['completed','failed'].includes(t.status)).length : 0;

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
```

**Step 2: Update dashboard to show in-progress tasks**

In the dashboard route, add an "In Progress" section above Recent Activity that queries tasks with non-terminal statuses and their latest `task_events` row:

```typescript
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
```

Display as a small "Live" section above the recent activity table.

**Step 3: Run all tests**

```bash
cd /home/clay/projects/tokens-at-home && pnpm test 2>&1 | tail -30
```

Expected: all passing.

**Step 4: Commit**

```bash
git add packages/coordinator/src/routes/ui.ts
git commit -m "feat(ui): add contributor profile page with GitHub link, add live in-progress task feed"
```

---

## Final verification

```bash
# Full build
pnpm build

# Full test suite
pnpm test

# Check for unused pledge/watchlist/generic-pledge references in source
grep -r "pledge\|watchlist\|generic.pledge\|autonomy\|trustScore" packages/*/src --include="*.ts" -l
```

The grep should only return files that are legitimately still referencing `trustScore` (kept internally in matching for future use) and nothing pledge-related.
