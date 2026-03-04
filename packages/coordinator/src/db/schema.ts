import { sql } from 'drizzle-orm';
import {
  integer,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  githubOwner: text('github_owner').notNull(),
  githubRepo: text('github_repo').notNull(),
  registeredBy: text('registered_by').notNull(),
  languages: text('languages').notNull(), // JSON array
  issueLabel: text('issue_label').notNull().default('tah'),
  claudeMd: text('claude_md'),
  taskTypes: text('task_types').notNull().default('["code"]'), // JSON array
  maxConcurrent: integer('max_concurrent').notNull().default(3),
  trustThreshold: real('trust_threshold').notNull().default(0),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const contributors = sqliteTable('contributors', {
  id: text('id').primaryKey(),
  githubUsername: text('github_username').notNull().unique(),
  languages: text('languages').notNull(), // JSON array
  autonomy: text('autonomy').notNull().default('review_before_pr'),
  cycleResetDate: text('cycle_reset_date'),
  maxConcurrent: integer('max_concurrent').notNull().default(1),
  trustScore: real('trust_score').notNull().default(0),
  available: integer('available', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const pledges = sqliteTable('pledges', {
  id: text('id').primaryKey(),
  contributorId: text('contributor_id')
    .notNull()
    .references(() => contributors.id),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  maxTasks: integer('max_tasks').notNull(),
  maxComplexity: text('max_complexity').notNull().default('large'),
  budgetPercent: integer('budget_percent').notNull().default(100),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const issues = sqliteTable('issues', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
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
  issueId: text('issue_id')
    .notNull()
    .references(() => issues.id),
  contributorId: text('contributor_id')
    .notNull()
    .references(() => contributors.id),
  pledgeId: text('pledge_id'),
  status: text('status').notNull().default('dispatched'),
  tokensUsed: integer('tokens_used'),
  prUrl: text('pr_url'),
  summary: text('summary'),
  errorDetails: text('error_details'),
  lastHeartbeatAt: text('last_heartbeat_at'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export const watchlist = sqliteTable('watchlist', {
  id: text('id').primaryKey(),
  contributorId: text('contributor_id')
    .notNull()
    .references(() => contributors.id),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const genericPledges = sqliteTable('generic_pledges', {
  id: text('id').primaryKey(),
  contributorId: text('contributor_id')
    .notNull()
    .references(() => contributors.id),
  maxTasks: integer('max_tasks').notNull(),
  maxComplexity: text('max_complexity').notNull().default('large'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// Auth tokens for daemon/CLI access
export const authTokens = sqliteTable('auth_tokens', {
  id: text('id').primaryKey(),
  contributorId: text('contributor_id')
    .notNull()
    .references(() => contributors.id),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});
