import { spawnSync } from 'child_process';
import type { Issue, Project, Task } from '@tah/shared';

export interface PrResult {
  prUrl: string;
}

export async function createPr(
  repoPath: string,
  task: Task,
  issue: Issue,
  project: Project,
  summary: string,
): Promise<PrResult> {
  const branchName = `tah/issue-${issue.githubNumber}`;

  // Stage all changes
  const addResult = spawnSync('git', ['add', '-A'], { cwd: repoPath, stdio: 'pipe' });
  if (addResult.status !== 0) {
    throw new Error(`git add failed: ${addResult.stderr.toString()}`);
  }

  // Check if there are any staged changes
  const statusResult = spawnSync('git', ['diff', '--cached', '--name-only'], {
    cwd: repoPath,
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  const changedFiles = statusResult.stdout.trim();

  if (!changedFiles) {
    throw new Error('No changes to commit after task execution');
  }

  // Commit
  const commitMsg = `fix(#${issue.githubNumber}): ${issue.title}\n\nResolved via Tokens at Home (task: ${task.id})\n\nCo-authored-by: Claude <noreply@anthropic.com>`;
  const commitResult = spawnSync('git', ['commit', '-m', commitMsg], {
    cwd: repoPath,
    stdio: 'pipe',
  });

  if (commitResult.status !== 0) {
    throw new Error(`git commit failed: ${commitResult.stderr.toString()}`);
  }

  // Push
  const pushResult = spawnSync('git', ['push', 'origin', branchName], {
    cwd: repoPath,
    stdio: 'pipe',
  });

  if (pushResult.status !== 0) {
    throw new Error(`git push failed: ${pushResult.stderr.toString()}`);
  }

  // Create PR via gh CLI
  const prBody = [
    `Closes #${issue.githubNumber}`,
    '',
    '## Summary',
    summary,
    '',
    '---',
    '_This PR was created autonomously by [Tokens at Home](https://github.com/tokens-at-home)._',
    '_A human contributor reviewed the changes before submission._',
  ].join('\n');

  const ghResult = spawnSync(
    'gh',
    [
      'pr', 'create',
      '--repo', `${project.githubOwner}/${project.githubRepo}`,
      '--title', `fix(#${issue.githubNumber}): ${issue.title}`,
      '--body', prBody,
      '--head', branchName,
    ],
    { cwd: repoPath, stdio: 'pipe', encoding: 'utf-8' },
  );

  if (ghResult.status !== 0) {
    throw new Error(`gh pr create failed: ${ghResult.stderr}`);
  }

  const prUrl = ghResult.stdout.trim();
  return { prUrl };
}
