import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TahApiClient } from './api.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('TahApiClient', () => {
  let client: TahApiClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new TahApiClient('http://localhost:3000', 'test-token');
  });

  it('sends Authorization header on GET', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: '1', githubUsername: 'alice' }),
    });

    await client.get('/contributors/me');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/contributors/me',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );
  });

  it('sends Authorization header on POST', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'proj1' }),
    });

    await client.post('/projects', { githubOwner: 'foo', githubRepo: 'bar', languages: ['js'] });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/projects',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('throws on non-ok responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'Not found',
    });

    await expect(client.get('/not-found')).rejects.toThrow('404');
  });

  it('works without an auth token', async () => {
    const unauthClient = new TahApiClient('http://localhost:3000');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    await unauthClient.get('/projects');

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });
});
