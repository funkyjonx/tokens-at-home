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
export const PHASE_TIMEOUTS_MS: Partial<Record<TaskStatus, number>> = {
  dispatched:  2 * 60 * 1000,
  cloning:     3 * 60 * 1000,
  working:    45 * 60 * 1000,
  review:     24 * 60 * 60 * 1000,
  submitting:  5 * 60 * 1000,
};

// Map GitHub issue label names to a complexity tier.
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
  phase: TaskStatus;
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
