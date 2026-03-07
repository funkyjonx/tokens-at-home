import { execSync } from 'child_process';

export function getGithubUsername(): string | null {
  try {
    return execSync('gh api user --jq .login', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}
