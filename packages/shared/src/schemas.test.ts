import { describe, it, expect } from 'vitest';
import {
  RegisterProjectSchema,
  RegisterContributorSchema,
  CompleteTaskSchema,
  FailTaskSchema,
} from './schemas.js';

describe('RegisterProjectSchema', () => {
  it('accepts valid input with defaults', () => {
    const result = RegisterProjectSchema.parse({
      githubOwner: 'acme',
      githubRepo: 'widget',
      languages: ['typescript'],
    });
    expect(result.issueLabel).toBe('tah');
    expect(result.taskTypes).toEqual(['code']);
    expect(result.maxConcurrent).toBe(3);
    expect(result.trustThreshold).toBe(0);
  });

  it('rejects empty languages', () => {
    expect(() =>
      RegisterProjectSchema.parse({
        githubOwner: 'acme',
        githubRepo: 'widget',
        languages: [],
      }),
    ).toThrow();
  });

  it('rejects invalid taskType', () => {
    expect(() =>
      RegisterProjectSchema.parse({
        githubOwner: 'acme',
        githubRepo: 'widget',
        languages: ['ts'],
        taskTypes: ['invalid'],
      }),
    ).toThrow();
  });
});

describe('RegisterContributorSchema', () => {
  it('defaults maxComplexity to medium', () => {
    const result = RegisterContributorSchema.parse({
      githubUsername: 'alice',
      languages: ['typescript'],
    });
    expect(result.maxComplexity).toBe('medium');
  });

  it('accepts explicit maxComplexity', () => {
    const result = RegisterContributorSchema.parse({
      githubUsername: 'bob',
      languages: ['rust'],
      maxComplexity: 'large',
    });
    expect(result.maxComplexity).toBe('large');
  });
});

describe('CompleteTaskSchema', () => {
  it('rejects invalid URL', () => {
    expect(() =>
      CompleteTaskSchema.parse({ prUrl: 'not-a-url', tokensUsed: 100, summary: 'done' }),
    ).toThrow();
  });

  it('accepts valid payload', () => {
    const result = CompleteTaskSchema.parse({
      prUrl: 'https://github.com/acme/widget/pull/1',
      tokensUsed: 5000,
      summary: 'Fixed the widget',
    });
    expect(result.tokensUsed).toBe(5000);
  });
});

describe('FailTaskSchema', () => {
  it('requires errorDetails', () => {
    expect(() => FailTaskSchema.parse({})).toThrow();
  });

  it('tokensUsed is optional', () => {
    const result = FailTaskSchema.parse({ errorDetails: 'Clone failed' });
    expect(result.tokensUsed).toBeUndefined();
  });
});
