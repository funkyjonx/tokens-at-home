// Core domain types for Tokens at Home

export type TaskType = 'code' | 'tests' | 'docs' | 'deps' | 'review';

export type IssueComplexity = 'trivial' | 'small' | 'medium' | 'large';

export type IssueStatus =
  | 'available'
  | 'assigned'
  | 'in_progress'
  | 'submitted'
  | 'merged'
  | 'rejected';

export type TaskStatus =
  | 'dispatched'
  | 'cloning'
  | 'working'
  | 'review'
  | 'submitting'
  | 'completed'
  | 'failed';

export type ContributorAutonomy = 'full' | 'review_before_pr';

// Token estimates by complexity (rough values for budget matching)
export const COMPLEXITY_TOKEN_ESTIMATES: Record<IssueComplexity, number> = {
  trivial: 2_000,
  small: 8_000,
  medium: 25_000,
  large: 80_000,
};

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
  autonomy: ContributorAutonomy;
  cycleResetDate?: string;
  maxConcurrent: number;
  trustScore: number;
  available: boolean;
  createdAt: string;
}

export interface Pledge {
  id: string;
  contributorId: string;
  projectId: string;
  budgetPercent: number;
  active: boolean;
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
  pledgeId?: string;
  status: TaskStatus;
  tokensUsed?: number;
  prUrl?: string;
  summary?: string;
  errorDetails?: string;
  createdAt: string;
  updatedAt: string;
}

// API response shapes
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
