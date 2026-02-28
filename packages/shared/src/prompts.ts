import type { Issue, Project, TaskType } from './types.js';

export interface PromptContext {
  issue: Issue;
  project: Project;
  repoPath: string;
}

// Tool sets per task type
export const ALLOWED_TOOLS: Record<TaskType, string[]> = {
  code: [
    'Bash(git *)',
    'Bash(npm *)',
    'Bash(pnpm *)',
    'Bash(yarn *)',
    'Bash(npx *)',
    'Read',
    'Edit',
    'Write',
    'Glob',
    'Grep',
  ],
  tests: [
    'Bash(git *)',
    'Bash(npm *)',
    'Bash(pnpm *)',
    'Bash(yarn *)',
    'Bash(npx *)',
    'Read',
    'Edit',
    'Write',
    'Glob',
    'Grep',
  ],
  docs: [
    'Bash(git *)',
    'Read',
    'Edit',
    'Write',
    'Glob',
    'Grep',
  ],
  deps: [
    'Bash(git *)',
    'Bash(npm *)',
    'Bash(pnpm *)',
    'Bash(yarn *)',
    'Bash(npx *)',
    'Read',
    'Edit',
    'Write',
  ],
  review: [
    'Bash(gh *)',
    'Read',
    'Glob',
    'Grep',
  ],
};

function header(project: Project, issue: Issue): string {
  return `You are an autonomous contributor to the open-source project ${project.githubOwner}/${project.githubRepo}.

Repository: https://github.com/${project.githubOwner}/${project.githubRepo}
Issue #${issue.githubNumber}: ${issue.title}

${project.claudeMd ? `## Project Context\n\n${project.claudeMd}\n\n` : ''}`;
}

function footer(): string {
  return `
## Instructions

- Work autonomously. Do not ask clarifying questions.
- Make the smallest correct change that resolves the issue.
- Follow existing code style and conventions.
- Run tests if a test command is available (check package.json or Makefile).
- Stage all changes with git but do NOT commit or push - that will be handled separately.
- When done, output a JSON summary:

\`\`\`json
{
  "summary": "Brief description of what you did",
  "filesChanged": ["list", "of", "changed", "files"],
  "testsPassed": true
}
\`\`\`
`;
}

export function buildCodePrompt(ctx: PromptContext): string {
  const { issue, project } = ctx;
  return `${header(project, issue)}
## Task: Fix/Implement Issue

Issue body:
---
${issue.body || '(no body)'}
---

Your job is to implement a fix or feature as described in the issue.
${footer()}`;
}

export function buildTestsPrompt(ctx: PromptContext): string {
  const { issue, project } = ctx;
  return `${header(project, issue)}
## Task: Add Tests

Issue body:
---
${issue.body || '(no body)'}
---

Your job is to add or improve tests to increase coverage as described in the issue.
- Identify untested code paths.
- Write tests using the existing test framework.
- Ensure all new tests pass.
${footer()}`;
}

export function buildDocsPrompt(ctx: PromptContext): string {
  const { issue, project } = ctx;
  return `${header(project, issue)}
## Task: Improve Documentation

Issue body:
---
${issue.body || '(no body)'}
---

Your job is to improve documentation as described in the issue.
- Update or create markdown files, JSDoc, or inline comments as appropriate.
- Be accurate and concise.
${footer()}`;
}

export function buildDepsPrompt(ctx: PromptContext): string {
  const { issue, project } = ctx;
  return `${header(project, issue)}
## Task: Update Dependencies

Issue body:
---
${issue.body || '(no body)'}
---

Your job is to update outdated dependencies as described in the issue.
- Update package versions conservatively (prefer minor/patch over major).
- Verify the project still builds and tests pass after updates.
- Document breaking changes in the PR description if any.
${footer()}`;
}

export function buildReviewPrompt(ctx: PromptContext): string {
  const { issue, project } = ctx;
  return `${header(project, issue)}
## Task: Review Pull Request

Issue body (PR description):
---
${issue.body || '(no body)'}
---

Your job is to review this pull request.
- Check for correctness, security issues, and style.
- Look for edge cases and missing tests.
- Output a structured review:

\`\`\`json
{
  "summary": "Overall assessment",
  "approved": false,
  "comments": [
    { "file": "path/to/file", "line": 42, "comment": "..." }
  ]
}
\`\`\`
`;
}

const PROMPT_BUILDERS: Record<TaskType, (ctx: PromptContext) => string> = {
  code: buildCodePrompt,
  tests: buildTestsPrompt,
  docs: buildDocsPrompt,
  deps: buildDepsPrompt,
  review: buildReviewPrompt,
};

export function buildPrompt(ctx: PromptContext): string {
  const builder = PROMPT_BUILDERS[ctx.issue.taskType];
  return builder(ctx);
}
