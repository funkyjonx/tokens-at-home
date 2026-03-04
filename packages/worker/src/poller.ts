import type { WorkerConfig, TaskAssignment, Pledge, GenericPledge } from '@tah/shared';

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

  async sendHeartbeat(taskId: string): Promise<{ ok: boolean; cancel: boolean }> {
    const res = await fetch(this.url(`/tasks/${taskId}/heartbeat`), {
      method: 'POST',
      headers: this.headers,
    });
    if (!res.ok) throw new Error(`Heartbeat failed: ${res.status}`);
    return res.json() as Promise<{ ok: boolean; cancel: boolean }>;
  }

  async updateStatus(taskId: string, status: string): Promise<void> {
    const res = await fetch(this.url(`/tasks/${taskId}/status`), {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify({ status }),
    });
    if (!res.ok) throw new Error(`Status update failed: ${res.status}`);
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

  async getPledges(): Promise<Pledge[]> {
    const res = await fetch(this.url('/contributors/me/pledges'), { headers: this.headers });
    if (!res.ok) throw new Error(`Get pledges failed: ${res.status}`);
    return res.json() as Promise<Pledge[]>;
  }

  async getGenericPledges(): Promise<GenericPledge[]> {
    const res = await fetch(this.url('/contributors/me/generic-pledges'), { headers: this.headers });
    if (!res.ok) throw new Error(`Get generic pledges failed: ${res.status}`);
    return res.json() as Promise<GenericPledge[]>;
  }

  async setAvailable(available: boolean): Promise<void> {
    const res = await fetch(this.url('/contributors/me/available'), {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify({ available }),
    });
    if (!res.ok) throw new Error(`Set available failed: ${res.status}`);
  }
}
