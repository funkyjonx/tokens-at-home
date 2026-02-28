// Thin API client for the coordinator

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

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(this.url(path), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`POST ${path} failed (${res.status}): ${err}`);
    }
    return res.json() as Promise<T>;
  }

  async get<T>(path: string): Promise<T> {
    const res = await fetch(this.url(path), { headers: this.headers });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`GET ${path} failed (${res.status}): ${err}`);
    }
    return res.json() as Promise<T>;
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(this.url(path), {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`PUT ${path} failed (${res.status}): ${err}`);
    }
    return res.json() as Promise<T>;
  }

  async delete<T>(path: string): Promise<T> {
    const res = await fetch(this.url(path), {
      method: 'DELETE',
      headers: this.headers,
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`DELETE ${path} failed (${res.status}): ${err}`);
    }
    return res.json() as Promise<T>;
  }
}
