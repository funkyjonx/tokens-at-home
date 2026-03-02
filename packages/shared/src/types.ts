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

// Token estimates by complexity (used for display and issue registration)
export const COMPLEXITY_TOKEN_ESTIMATES: Record<IssueComplexity, number> = {
  trivial: 2_000,
  small: 8_000,
  medium: 25_000,
  large: 80_000,
};

// Numeric ordering for complexity tiers (used in pledge matching)
export const COMPLEXITY_ORDER: Record<IssueComplexity, number> = {
  trivial: 1,
  small: 2,
  medium: 3,
  large: 4,
};

// Map GitHub issue label names to a complexity tier.
// Returns null if no recognizable label is found.
export function mapGitHubLabelsToComplexity(labels: string[]): IssueComplexity | null {
  for (const label of labels) {
    const l = label.toLowerCase().trim();

    // trivial: good first issue variants, XS size labels
    if (/good.first.(issue|contribution)|beginner|starter|first-timer/.test(l)) return 'trivial';
    if (/^(size[/:_\s-]+)?x-?s(mall)?$/.test(l)) return 'trivial';

    // small: S size labels, effort/complexity signals
    if (/^(size[/:_\s-]+)?s(mall)?$/.test(l)) return 'small';
    if (/(effort|complexity)[/:_\s-]*(small|easy|low|minimal|simple|minor)/.test(l)) return 'small';

    // medium: M size labels
    if (/^(size[/:_\s-]+)?m(edium)?$/.test(l)) return 'medium';
    if (/(effort|complexity)[/:_\s-]*(medium|moderate|normal)/.test(l)) return 'medium';

    // large: L/XL/XXL size labels, high-effort signals
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
  maxTasks: number;
  maxComplexity: IssueComplexity;
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

export type ActivityEvent =
  | { type: 'project_registered'; ts: string; actor: string; project: string; projectId: string }
  | { type: 'contributor_joined'; ts: string; actor: string }
  | { type: 'pledge_created'; ts: string; actor: string; project: string; maxTasks: number; maxComplexity: string }
  | { type: 'task_completed'; ts: string; actor: string; project: string; issueNumber: number; tokensUsed: number; prUrl: string }
  | { type: 'task_failed'; ts: string; actor: string; project: string; issueNumber: number; errorDetails?: string };
