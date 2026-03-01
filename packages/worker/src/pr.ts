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
  contributorUsername: string,
): Promise<PrResult> {
  const branchName = `tah/issue-${issue.githubNumber}`;
  const upstreamRepo = `${project.githubOwner}/${project.githubRepo}`;

  // Stage all changes
  const addResult = spawnSync('git', ['add', '-A'], { cwd: repoPath, stdio: 'pipe' });
  if (addResult.status !== 0) {
    throw new Error(`git add failed: ${addResult.stderr.toString()}`);
  }

  // Bail early if nothing changed
  const statusResult = spawnSync('git', ['diff', '--cached', '--name-only'], {
    cwd: repoPath,
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  if (!statusResult.stdout.trim()) {
    throw new Error('No changes to commit after task execution');
  }

  // Commit
  const commitMsg = [
    `fix(#${issue.githubNumber}): ${issue.title}`,
    '',
    `Resolved via Tokens at Home (task: ${task.id})`,
    '',
    'Co-authored-by: Claude <noreply@anthropic.com>',
  ].join('\n');

  const commitResult = spawnSync('git', ['commit', '-m', commitMsg], {
    cwd: repoPath,
    stdio: 'pipe',
  });
  if (commitResult.status !== 0) {
    throw new Error(`git commit failed: ${commitResult.stderr.toString()}`);
  }

  // Determine whether to push directly (owner) or via fork (contributor)
  const isOwner = project.githubOwner.toLowerCase() === contributorUsername.toLowerCase();

  let prHead: string;

  if (isOwner || !contributorUsername) {
    // Contributor owns the repo — push directly to origin
    const pushResult = spawnSync('git', ['push', 'origin', branchName], {
      cwd: repoPath,
      stdio: 'pipe',
    });
    if (pushResult.status !== 0) {
      throw new Error(`git push failed: ${pushResult.stderr.toString()}`);
    }
    prHead = branchName;
  } else {
    // Fork-based flow for external contributions
    //
    // 1. Create (or reuse) a fork under the contributor's account
    const forkResult = spawnSync(
      'gh',
      ['repo', 'fork', upstreamRepo, '--clone=false'],
      { cwd: repoPath, stdio: 'pipe', encoding: 'utf-8' },
    );
    if (forkResult.status !== 0) {
      throw new Error(`gh repo fork failed: ${forkResult.stderr}`);
    }

    // 2. Add fork remote (ignore error if it already exists)
    const forkUrl = `https://github.com/${contributorUsername}/${project.githubRepo}.git`;
    spawnSync('git', ['remote', 'add', 'fork', forkUrl], { cwd: repoPath, stdio: 'pipe' });

    // 3. Push branch to fork
    const pushResult = spawnSync('git', ['push', 'fork', branchName], {
      cwd: repoPath,
      stdio: 'pipe',
    });
    if (pushResult.status !== 0) {
      throw new Error(`git push to fork failed: ${pushResult.stderr.toString()}`);
    }

    prHead = `${contributorUsername}:${branchName}`;
  }

  // Create PR against the upstream repo
  const prBody = [
    `Closes #${issue.githubNumber}`,
    '',
    '## Summary',
    summary,
    '',
    '---',
    '_This PR was created autonomously by [Tokens at Home](https://github.com/funkyjonx/tokens-at-home)._',
    '_A human contributor reviewed the changes before submission._',
  ].join('\n');

  const ghResult = spawnSync(
    'gh',
    [
      'pr', 'create',
      '--repo', upstreamRepo,
      '--title', `fix(#${issue.githubNumber}): ${issue.title}`,
      '--body', prBody,
      '--head', prHead,
    ],
    { cwd: repoPath, stdio: 'pipe', encoding: 'utf-8' },
  );

  if (ghResult.status !== 0) {
    throw new Error(`gh pr create failed: ${ghResult.stderr}`);
  }

  return { prUrl: ghResult.stdout.trim() };
}
