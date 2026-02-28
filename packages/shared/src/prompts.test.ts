import { describe, it, expect } from 'vitest';
import { buildPrompt, buildCodePrompt, buildTestsPrompt, ALLOWED_TOOLS } from './prompts.js';
import type { Issue, Project } from './types.js';

const project: Project = {
  id: 'proj-1',
  githubOwner: 'acme',
  githubRepo: 'widget',
  registeredBy: 'alice',
  languages: ['typescript'],
  issueLabel: 'tah',
  taskTypes: ['code'],
  maxConcurrent: 3,
  trustThreshold: 0,
  createdAt: '2024-01-01T00:00:00Z',
};

const issue: Issue = {
  id: 'issue-1',
  projectId: 'proj-1',
  githubNumber: 42,
  title: 'Fix the widget',
  body: 'The widget is broken.',
  taskType: 'code',
  estimatedComplexity: 'small',
  estimatedTokens: 8000,
  status: 'available',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

const ctx = { issue, project, repoPath: '/tmp/repo' };

describe('buildPrompt', () => {
  it('includes the repo name', () => {
    const p = buildPrompt(ctx);
    expect(p).toContain('acme/widget');
  });

  it('includes the issue number and title', () => {
    const p = buildPrompt(ctx);
    expect(p).toContain('#42');
    expect(p).toContain('Fix the widget');
  });

  it('includes the issue body', () => {
    const p = buildPrompt(ctx);
    expect(p).toContain('The widget is broken.');
  });

  it('includes project claudeMd when present', () => {
    const withMd = buildPrompt({
      ...ctx,
      project: { ...project, claudeMd: 'Use pnpm, not npm.' },
    });
    expect(withMd).toContain('Use pnpm, not npm.');
  });

  it('delegates to correct builder per task type', () => {
    const testsIssue = { ...issue, taskType: 'tests' as const };
    const p = buildPrompt({ ...ctx, issue: testsIssue });
    expect(p).toContain('Add Tests');
  });
});

describe('ALLOWED_TOOLS', () => {
  it('code tasks include Edit and Write', () => {
    expect(ALLOWED_TOOLS.code).toContain('Edit');
    expect(ALLOWED_TOOLS.code).toContain('Write');
  });

  it('review tasks do not include Edit or Write', () => {
    expect(ALLOWED_TOOLS.review).not.toContain('Edit');
    expect(ALLOWED_TOOLS.review).not.toContain('Write');
  });

  it('docs tasks do not include npm commands', () => {
    const hasBashNpm = ALLOWED_TOOLS.docs.some((t) => t.includes('npm'));
    expect(hasBashNpm).toBe(false);
  });
});
