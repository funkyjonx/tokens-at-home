import { createInterface } from 'readline';
import { execSync } from 'child_process';
import type { Issue, Project } from '@tah/shared';

export interface ReviewDecision {
  approved: boolean;
  reason?: string;
}

// Show a diff and ask the contributor to approve or reject before PR submission.
export async function humanReview(
  repoPath: string,
  issue: Issue,
  project: Project,
): Promise<ReviewDecision> {
  const isTTY = process.stdin.isTTY && process.stdout.isTTY;

  if (!isTTY) {
    // The daemon must run in a foreground terminal so contributors can review diffs.
    // Auto-approving in non-interactive mode would defeat the purpose of review_before_pr.
    throw new Error(
      'Human review requires an interactive terminal. Run `tah worker start` in a foreground shell.',
    );
  }

  // Show the diff
  console.log('\n==========================================================');
  console.log(`Review changes for: ${project.githubOwner}/${project.githubRepo}#${issue.githubNumber}`);
  console.log(`Issue: ${issue.title}`);
  console.log('==========================================================\n');

  try {
    const diff = execSync('git diff HEAD', { cwd: repoPath, encoding: 'utf-8' });
    if (diff.trim()) {
      console.log(diff);
    } else {
      // Maybe changes are staged
      const stagedDiff = execSync('git diff --cached', { cwd: repoPath, encoding: 'utf-8' });
      if (stagedDiff.trim()) {
        console.log(stagedDiff);
      } else {
        console.log('(no changes detected)');
      }
    }
  } catch {
    console.log('(could not generate diff)');
  }

  console.log('\n----------------------------------------------------------');

  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question('Submit PR? [y/N] ', (answer) => {
      rl.close();
      const approved = answer.trim().toLowerCase() === 'y';
      resolve(approved ? { approved: true } : { approved: false, reason: 'Rejected by contributor' });
    });
  });
}
