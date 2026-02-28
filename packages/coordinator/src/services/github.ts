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
