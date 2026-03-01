import { z } from 'zod';

// Enums
export const TaskTypeSchema = z.enum(['code', 'tests', 'docs', 'deps', 'review']);
export const IssueComplexitySchema = z.enum(['trivial', 'small', 'medium', 'large']);
export const IssueStatusSchema = z.enum([
  'available', 'assigned', 'in_progress', 'submitted', 'merged', 'rejected',
]);
export const TaskStatusSchema = z.enum([
  'dispatched', 'cloning', 'working', 'review', 'submitting', 'completed', 'failed',
]);
export const ContributorAutonomySchema = z.enum(['full', 'review_before_pr']);

// Registration
export const RegisterProjectSchema = z.object({
  githubOwner: z.string().min(1),
  githubRepo: z.string().min(1),
  languages: z.array(z.string()).min(1),
  issueLabel: z.string().default('tah'),
  claudeMd: z.string().optional(),
  taskTypes: z.array(TaskTypeSchema).min(1).default(['code']),
  maxConcurrent: z.number().int().min(1).max(20).default(3),
  trustThreshold: z.number().min(0).max(1).default(0),
});
export type RegisterProjectInput = z.infer<typeof RegisterProjectSchema>;

export const RegisterContributorSchema = z.object({
  githubUsername: z.string().min(1),
  languages: z.array(z.string()).min(1),
  autonomy: ContributorAutonomySchema.default('review_before_pr'),
  cycleResetDate: z.string().datetime().optional(),
  maxConcurrent: z.number().int().min(1).max(5).default(1),
});
export type RegisterContributorInput = z.infer<typeof RegisterContributorSchema>;

export const CreatePledgeSchema = z.object({
  projectId: z.string().min(1),
  budgetPercent: z.number().min(1).max(100),
});
export type CreatePledgeInput = z.infer<typeof CreatePledgeSchema>;

export const SetAvailableSchema = z.object({
  available: z.boolean(),
});

export const SetBudgetSchema = z.object({
  budgetPercent: z.number().min(1).max(100),
});

// Issue management
export const RegisterIssueSchema = z.object({
  projectId: z.string().min(1),
  githubNumber: z.number().int().positive(),
  title: z.string().min(1),
  body: z.string(),
  taskType: TaskTypeSchema,
  estimatedComplexity: IssueComplexitySchema.optional(),
});
export type RegisterIssueInput = z.infer<typeof RegisterIssueSchema>;

// Manual assignment (MVP - no auto-matching)
export const AssignTaskSchema = z.object({
  issueId: z.string().min(1),
  contributorId: z.string().min(1),
});
export type AssignTaskInput = z.infer<typeof AssignTaskSchema>;

// Task lifecycle
export const CompleteTaskSchema = z.object({
  prUrl: z.string().url(),
  tokensUsed: z.number().int().min(0),
  summary: z.string().min(1),
});
export type CompleteTaskInput = z.infer<typeof CompleteTaskSchema>;

export const FailTaskSchema = z.object({
  errorDetails: z.string().min(1),
  tokensUsed: z.number().int().min(0).optional(),
});
export type FailTaskInput = z.infer<typeof FailTaskSchema>;

// Daemon config stored locally
export const DaemonConfigSchema = z.object({
  coordinatorUrl: z.string().url(),
  contributorId: z.string().min(1),
  authToken: z.string().min(1),
  pollIntervalMs: z.number().int().min(5_000).default(30_000),
  workDir: z.string().min(1).optional(),
  logDir: z.string().min(1).optional(),
  autonomy: ContributorAutonomySchema.optional(),
  githubUsername: z.string().optional(),
});
export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;
