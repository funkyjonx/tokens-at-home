// Thin API client for the coordinator

export class TahApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'TahApiError';
  }
}

export class TahApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
  ) {}

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    return h;
  }

  private url(path: string) {
    return `${this.baseUrl}${path}`;
  }

  private async fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new Error('Request to coordinator timed out.');
      }
      throw new Error(`Could not reach coordinator at ${this.baseUrl}. Is it running?`);
    }
    return res;
  }

  private async throwHttpError(method: string, path: string, res: Response): Promise<never> {
    let errorMessage: string;
    try {
      const body = await res.json() as { error?: string };
      errorMessage = body.error ?? res.statusText ?? String(res.status);
    } catch {
      try {
        errorMessage = await res.text();
      } catch {
        errorMessage = res.statusText ?? String(res.status);
      }
    }
    throw new TahApiError(`${method} ${path} failed (${res.status}): ${errorMessage}`, res.status);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchWithTimeout(this.url(path), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) return this.throwHttpError('POST', path, res);
    return res.json() as Promise<T>;
  }

  async get<T>(path: string): Promise<T> {
    const res = await this.fetchWithTimeout(this.url(path), { headers: this.headers });
    if (!res.ok) return this.throwHttpError('GET', path, res);
    return res.json() as Promise<T>;
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchWithTimeout(this.url(path), {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) return this.throwHttpError('PUT', path, res);
    return res.json() as Promise<T>;
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchWithTimeout(this.url(path), {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) return this.throwHttpError('PATCH', path, res);
    return res.json() as Promise<T>;
  }

  async delete<T>(path: string): Promise<T> {
    const res = await this.fetchWithTimeout(this.url(path), {
      method: 'DELETE',
      headers: this.headers,
    });
    if (!res.ok) return this.throwHttpError('DELETE', path, res);
    return res.json() as Promise<T>;
  }

  async resolveProjectId(idOrSlug: string): Promise<string> {
    if (idOrSlug.includes('/')) {
      const [owner, repo] = idOrSlug.split('/');
      const project = await this.findProjectByRepo(owner, repo);
      if (!project) throw new Error(`Project ${idOrSlug} not found.`);
      return project.id;
    }
    return idOrSlug;
  }

  async findProjectByRepo(owner: string, repo: string): Promise<{ id: string } | null> {
    const results = await this.get<Array<{ id: string; githubOwner: string; githubRepo: string }>>(`/projects?q=${encodeURIComponent(owner + '/' + repo)}`);
    return results.find((p) => p.githubOwner === owner && p.githubRepo === repo) ?? null;
  }

  async pinProject(projectId: string): Promise<void> {
    await this.post('/contributors/me/pins', { projectId });
  }

  async unpinProject(projectId: string): Promise<void> {
    await this.delete(`/contributors/me/pins/${projectId}`);
  }
}
