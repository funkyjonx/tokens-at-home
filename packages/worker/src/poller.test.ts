import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CoordinatorClient } from './poller.js';

const baseConfig = {
  coordinatorUrl: 'http://localhost:3000',
  contributorId: 'test-id',
  authToken: 'test-token',
  githubUsername: 'testuser',
  maxComplexity: 'medium' as const,
  pollIntervalMs: 30000,
};

describe('CoordinatorClient.getNextTask', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when server responds with 204', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 204, ok: true }));
    const client = new CoordinatorClient(baseConfig);
    const result = await client.getNextTask();
    expect(result).toBeNull();
  });

  it('returns { budgetExhausted: true } when server signals budget exhaustion', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve({ budgetExhausted: true }),
    }));
    const client = new CoordinatorClient(baseConfig);
    const result = await client.getNextTask();
    expect(result).toEqual({ budgetExhausted: true });
  });

  it('returns task assignment when server provides one', async () => {
    const assignment = { task: { id: 'task-1' }, issue: { id: 'issue-1' }, project: { id: 'proj-1' } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve(assignment),
    }));
    const client = new CoordinatorClient(baseConfig);
    const result = await client.getNextTask();
    expect(result).toEqual(assignment);
  });

  it('throws when server responds with error status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 500, ok: false }));
    const client = new CoordinatorClient(baseConfig);
    await expect(client.getNextTask()).rejects.toThrow('GET /tasks/next failed: 500');
  });
});
