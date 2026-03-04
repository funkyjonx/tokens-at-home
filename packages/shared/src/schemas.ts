import { z } from 'zod';

// Enums
export const TaskTypeSchema = z.enum(['code', 'tests', 'docs', 'deps', 'review']);
export const IssueComplexitySchema = z.enum(['trivial', 'small', 'medium', 'large']);
export const IssueStatusSchema = z.enum([
  'available', 'assigned', 'in_progress', 'submitted', 'merged', 'rejected', 'cancelled',
]);
export const TaskStatusSchema = z.enum([
  'dispatched', 'cloning', 'working', 'review', 'submitting', 'completed', 'failed',
]);
export const ContributorAutonomySchema = z.enum(['full', 'review_before_pr']);

// Shared field validators
const githubOwner = z.string()
  .min(1)
  .max(39)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/, 'Invalid GitHub owner name');

const githubRepoName = z.string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Invalid GitHub repository name');

const languageList = z.array(z.string().min(1).max(50)).min(1).max(20);

// Registration
export const RegisterProjectSchema = z.object({
  githubOwner,
  githubRepo: githubRepoName,
  languages: languageList,
  issueLabel: z.string().min(1).max(50).default('tah'),
  claudeMd: z.string().max(4000).optional(),
  taskTypes: z.array(TaskTypeSchema).min(1).max(5).default(['code']),
  maxConcurrent: z.number().int().min(1).max(20).default(3),
  trustThreshold: z.number().min(0).max(1).default(0),
});
export type RegisterProjectInput = z.infer<typeof RegisterProjectSchema>;

export const RegisterContributorSchema = z.object({
  githubUsername: githubOwner,
  languages: languageList,
  autonomy: ContributorAutonomySchema.default('review_before_pr'),
  cycleResetDate: z.string().datetime().optional(),
  maxConcurrent: z.number().int().min(1).max(5).default(1),
});
export type RegisterContributorInput = z.infer<typeof RegisterContributorSchema>;

export const CreatePledgeSchema = z.object({
  projectId: z.string().min(1).max(32),
  maxTasks: z.number().int().min(1).max(1000),
  maxComplexity: IssueComplexitySchema.default('large'),
});
export type CreatePledgeInput = z.infer<typeof CreatePledgeSchema>;

export const SetAvailableSchema = z.object({
  available: z.boolean(),
});

// Issue management
export const RegisterIssueSchema = z.object({
  projectId: z.string().min(1).max(32),
  githubNumber: z.number().int().positive().max(1_000_000),
  title: z.string().min(1).max(500).optional(),   // fetched from GitHub if omitted
  body: z.string().max(100_000).optional(),        // fetched from GitHub if omitted
  taskType: TaskTypeSchema,
  estimatedComplexity: IssueComplexitySchema.optional(),
});
export type RegisterIssueInput = z.infer<typeof RegisterIssueSchema>;

// Manual assignment (MVP - no auto-matching)
export const AssignTaskSchema = z.object({
  issueId: z.string().min(1).max(32),
  contributorId: z.string().min(1).max(32),
});
export type AssignTaskInput = z.infer<typeof AssignTaskSchema>;

// Task lifecycle
export const UpdateTaskStatusSchema = z.object({
  status: TaskStatusSchema,
});

export const CompleteTaskSchema = z.object({
  prUrl: z.string().url().max(500).refine(
    (url) => { try { return new URL(url).hostname.endsWith('github.com'); } catch { return false; } },
    'PR URL must be on github.com',
  ),
  tokensUsed: z.number().int().min(0).max(10_000_000),
  summary: z.string().min(1).max(2000),
});
export type CompleteTaskInput = z.infer<typeof CompleteTaskSchema>;

export const FailTaskSchema = z.object({
  errorDetails: z.string().min(1).max(10_000),
  tokensUsed: z.number().int().min(0).max(10_000_000).optional(),
});
export type FailTaskInput = z.infer<typeof FailTaskSchema>;

// Worker config stored locally
export const WorkerConfigSchema = z.object({
  coordinatorUrl: z.string().url(),
  contributorId: z.string().min(1),
  authToken: z.string().min(1),
  pollIntervalMs: z.number().int().min(5_000).default(30_000),
  workDir: z.string().min(1).optional(),
  logDir: z.string().min(1).optional(),
  autonomy: ContributorAutonomySchema.optional(),
  githubUsername: z.string().optional(),
});
export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;
