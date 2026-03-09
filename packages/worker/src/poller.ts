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

  async getNextTask(): Promise<TaskAssignment | { budgetExhausted: true } | null> {
    const res = await fetch(this.url('/tasks/next'), { headers: this.headers });
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`GET /tasks/next failed: ${res.status}`);
    const data = await res.json() as Record<string, unknown>;
    if (data['budgetExhausted'] === true) return { budgetExhausted: true as const };
    return data as unknown as TaskAssignment;
  }

  async sendProgress(taskId: string, phase: string, tokensUsed?: number, elapsedMs?: number): Promise<void> {
    const res = await fetch(this.url(`/tasks/${taskId}/progress`), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ phase, tokensUsed, elapsedMs }),
    });
    if (!res.ok) throw new Error(`Progress update failed: ${res.status}`);
  }

  async completeTask(
    taskId: string,
    prUrl: string,
    tokensUsed: number,
    summary: string,
  ): Promise<void> {
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
