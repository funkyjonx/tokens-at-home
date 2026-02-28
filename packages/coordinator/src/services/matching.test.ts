import { describe, it, expect } from 'vitest';
import { scoreMatch } from './matching.js';
import type { Contributor, Issue, Project, Pledge } from '@tah/shared';

const project: Project = {
  id: 'proj-1',
  githubOwner: 'acme',
  githubRepo: 'widget',
  registeredBy: 'alice',
  languages: ['typescript', 'rust'],
  issueLabel: 'tah',
  taskTypes: ['code'],
  maxConcurrent: 3,
  trustThreshold: 0,
  createdAt: '2024-01-01T00:00:00Z',
};

const contributor: Contributor = {
  id: 'contrib-1',
  githubUsername: 'alice',
  languages: ['typescript', 'python'],
  autonomy: 'review_before_pr',
  maxConcurrent: 1,
  trustScore: 0,
  available: true,
  createdAt: '2024-01-01T00:00:00Z',
};

const pledge: Pledge = {
  id: 'pledge-1',
  contributorId: 'contrib-1',
  projectId: 'proj-1',
  budgetPercent: 80,
  active: true,
  createdAt: '2024-01-01T00:00:00Z',
};

const issue: Issue = {
  id: 'issue-1',
  projectId: 'proj-1',
  githubNumber: 42,
  title: 'Fix widget',
  body: '',
  taskType: 'code',
  estimatedComplexity: 'small',
  estimatedTokens: 8_000,
  status: 'available',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

describe('scoreMatch', () => {
  it('returns a positive score for a valid match', () => {
    const score = scoreMatch(contributor, issue, project, pledge);
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThan(0);
  });

  it('returns null when contributor trust is below project threshold', () => {
    const strictProject = { ...project, trustThreshold: 0.5 };
    const newContributor = { ...contributor, trustScore: 0 };
    const score = scoreMatch(newContributor, issue, strictProject, pledge);
    expect(score).toBeNull();
  });

  it('returns null when issue exceeds budget', () => {
    const smallBudget = { ...pledge, budgetPercent: 1 }; // ~1000 tokens available
    const largeIssue = { ...issue, estimatedTokens: 80_000 };
    const score = scoreMatch(contributor, largeIssue, project, smallBudget);
    expect(score).toBeNull();
  });

  it('returns null when task type not in project taskTypes', () => {
    const testIssue = { ...issue, taskType: 'tests' as const };
    const score = scoreMatch(contributor, testIssue, project, pledge);
    expect(score).toBeNull();
  });

  it('higher language overlap gives higher score', () => {
    const fullOverlapContributor = { ...contributor, languages: ['typescript', 'rust'] };
    const noOverlapContributor = { ...contributor, languages: ['python', 'go'] };

    const fullScore = scoreMatch(fullOverlapContributor, issue, project, pledge);
    const noScore = scoreMatch(noOverlapContributor, issue, project, pledge);

    expect(fullScore!).toBeGreaterThan(noScore!);
  });

  it('higher trust score gives higher score', () => {
    const trustedContributor = { ...contributor, trustScore: 1 };
    const newContributor = { ...contributor, trustScore: 0 };

    const trustedScore = scoreMatch(trustedContributor, issue, project, pledge);
    const newScore = scoreMatch(newContributor, issue, project, pledge);

    expect(trustedScore!).toBeGreaterThan(newScore!);
  });
});
