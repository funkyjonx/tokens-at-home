import { load as parseYaml } from 'js-yaml';
import { TaskTypeSchema } from '@tah/shared';
import type { TaskType } from '@tah/shared';

// GitHub API helpers for verifying repo access and syncing issues

export interface GitHubRepo {
  id: number;
  full_name: string;
  private: boolean;
  owner: { login: string };
  name: string;
  language: string | null;
}

export interface GitHubUser {
  login: string;
  id: number;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
}

export class GitHubClient {
  private readonly baseUrl = 'https://api.github.com';

  constructor(private readonly token: string) {}

  private async request<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'tokens-at-home/1.0',
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub API error ${res.status}: ${path}`);
    }
    return res.json() as Promise<T>;
  }

  async getAuthenticatedUser(): Promise<GitHubUser> {
    return this.request<GitHubUser>('/user');
  }

  async getRepo(owner: string, repo: string): Promise<GitHubRepo> {
    return this.request<GitHubRepo>(`/repos/${owner}/${repo}`);
  }

  async hasWriteAccess(owner: string, repo: string, username: string): Promise<boolean> {
    try {
      const res = await fetch(
        `${this.baseUrl}/repos/${owner}/${repo}/collaborators/${username}/permission`,
        {
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'tokens-at-home/1.0',
          },
        },
      );
      if (!res.ok) return false;
      const data = (await res.json()) as { permission: string };
      return ['write', 'admin', 'maintain'].includes(data.permission);
    } catch {
      return false;
    }
  }

  async getIssue(owner: string, repo: string, number: number): Promise<GitHubIssue> {
    return this.request<GitHubIssue>(`/repos/${owner}/${repo}/issues/${number}`);
  }

  async listIssuesByLabel(
    owner: string,
    repo: string,
    label: string,
  ): Promise<GitHubIssue[]> {
    return this.request<GitHubIssue[]>(
      `/repos/${owner}/${repo}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=50`,
    );
  }
}

const GH_API = 'https://api.github.com';
const HEADERS = {
  'User-Agent': 'tokens-at-home',
  Accept: 'application/vnd.github.v3+json',
};

export interface TahConfig {
  label: string;
  maxConcurrent: number;
  taskTypes: TaskType[];
}

export const DEFAULT_TAH_CONFIG: TahConfig = {
  label: 'tah',
  maxConcurrent: 3,
  taskTypes: ['code'],
};

/** Fetch primary languages for a repo. Returns lowercase language names. */
export async function fetchRepoLanguages(owner: string, repo: string): Promise<string[]> {
  try {
    const res = await fetch(`${GH_API}/repos/${owner}/${repo}/languages`, { headers: HEADERS });
    if (!res.ok) return ['typescript'];
    const data = await res.json() as Record<string, number>;
    return Object.keys(data).map((l) => l.toLowerCase()).slice(0, 5);
  } catch {
    return ['typescript'];
  }
}

/** Fetch and parse .tah.yml from a repo's default branch. Falls back to defaults. */
export async function fetchTahConfig(owner: string, repo: string): Promise<TahConfig> {
  try {
    const res = await fetch(
      `${GH_API}/repos/${owner}/${repo}/contents/.tah.yml`,
      { headers: HEADERS },
    );
    if (!res.ok) return DEFAULT_TAH_CONFIG;

    const data = await res.json() as { content?: string; encoding?: string };
    if (!data.content || data.encoding !== 'base64') return DEFAULT_TAH_CONFIG;

    const yaml = Buffer.from(data.content, 'base64').toString('utf-8');
    const parsed = parseYaml(yaml) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return DEFAULT_TAH_CONFIG;

    const label = typeof parsed['label'] === 'string' ? parsed['label'] : DEFAULT_TAH_CONFIG.label;
    const maxConcurrent = typeof parsed['maxConcurrent'] === 'number'
      ? Math.max(1, Math.min(20, parsed['maxConcurrent']))
      : DEFAULT_TAH_CONFIG.maxConcurrent;

    const rawTypes = Array.isArray(parsed['taskTypes']) ? parsed['taskTypes'] : [];
    const taskTypes = rawTypes
      .filter((t): t is TaskType => TaskTypeSchema.safeParse(t).success)
      .slice(0, 5);

    return {
      label,
      maxConcurrent,
      taskTypes: taskTypes.length > 0 ? taskTypes : DEFAULT_TAH_CONFIG.taskTypes,
    };
  } catch {
    return DEFAULT_TAH_CONFIG;
  }
}
