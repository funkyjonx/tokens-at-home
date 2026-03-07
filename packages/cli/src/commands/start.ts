import { Command } from 'commander';
import { createInterface } from 'readline';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { loadConfig, saveConfig, DEFAULT_COORDINATOR_URL } from '../config.js';
import { TahApiClient } from '../api.js';
import type { Contributor, IssueComplexity } from '@tah/shared';

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

function getGithubUsername(): string | null {
  try {
    return execSync('gh api user --jq .login', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function findWorkerBin(): string {
  const thisDir = dirname(new URL(import.meta.url).pathname);
  const candidates = [
    join(thisDir, '../../worker/dist/index.js'),
    join(thisDir, '../../../@tah/worker/dist/index.js'),
    join(process.cwd(), 'packages', 'worker', 'dist', 'index.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Worker binary not found. Run 'pnpm build' in the monorepo or ensure @tah/worker is installed.");
}

export function startCommand(): Command {
  return new Command('start')
    .description('Register (if needed) and start the worker')
    .option('--coordinator <url>', 'Coordinator URL', DEFAULT_COORDINATOR_URL)
    .action(async (opts: { coordinator: string }) => {
      const config = loadConfig();
      const coordinatorUrl = opts.coordinator ?? config.coordinatorUrl;

      // If already registered, verify token then start
      if (config.authToken && config.contributorId) {
        // Verify token is still valid before launching worker
        const api = new TahApiClient(coordinatorUrl, config.authToken);
        try {
          await api.get('/contributors/me');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('(401)')) {
            console.log('\n  Your session has expired. Let\'s re-register.\n');
            saveConfig({ ...config, authToken: undefined, contributorId: undefined, githubUsername: undefined });
            // Fall through to registration flow below
          } else {
            console.error(`  Could not reach coordinator: ${msg}`);
            process.exit(1);
          }
        }
        // Re-read config to check if token is still valid (not cleared by 401 path)
        const freshConfig = loadConfig();
        if (freshConfig.authToken && freshConfig.contributorId) {
          console.log('Config found. Starting worker...');
          const workerBin = findWorkerBin();
          const child = spawn(process.execPath, [workerBin], { stdio: 'inherit', env: { ...process.env } });
          await new Promise<void>((resolve) => child.on('exit', () => resolve()));
          process.exit(child.exitCode ?? 1);
          return;
        }
        // Token was cleared — fall through to registration flow
      }

      console.log('\n  Tokens at Home — donate your Claude capacity to open source\n');

      const rl = createInterface({ input: process.stdin, output: process.stdout });

      let username: string | undefined;
      const detected = getGithubUsername();
      if (detected) {
        const confirm = await prompt(rl, `  Register as ${detected}? [Y/n]: `);
        username = confirm.toLowerCase() === 'n' ? (await prompt(rl, '  GitHub username: ')) : detected;
      } else {
        username = await prompt(rl, '  GitHub username: ');
      }

      if (!username) {
        console.error('Username required');
        rl.close();
        process.exit(1);
      }

      const langsRaw = await prompt(rl, '  Languages (comma-separated, e.g. typescript,python) [typescript]: ');
      const languages = langsRaw
        ? langsRaw.split(',').map((l) => l.trim().toLowerCase()).filter(Boolean)
        : ['typescript'];

      const maxConcurrentStr = await prompt(rl, '  Max concurrent tasks [1]: ');
      const maxConcurrent = parseInt(maxConcurrentStr || '1', 10) || 1;

      const maxComplexityRaw = await prompt(rl, '  Max complexity (trivial/small/medium/large) [medium]: ');
      const maxComplexity = (['trivial', 'small', 'medium', 'large'].includes(maxComplexityRaw)
        ? maxComplexityRaw : 'medium') as IssueComplexity;

      rl.close();

      const api = new TahApiClient(coordinatorUrl);
      let result: { contributor: Contributor; token: string };
      try {
        result = await api.post<{ contributor: Contributor; token: string }>('/contributors', {
          githubUsername: username,
          languages,
          maxConcurrent,
          maxComplexity,
        });

        saveConfig({
          ...config,
          coordinatorUrl,
          contributorId: result.contributor.id,
          authToken: result.token,
          githubUsername: result.contributor.githubUsername,
        });
      } catch (err) {
        rl.close();
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('(409)')) {
          console.error(`\n  Username "${username}" is already registered.\n  If this is you, your config may be missing. Contact support to recover your token.`);
        } else if (msg.includes('(400)')) {
          console.error(`\n  Registration failed: ${msg}`);
        } else {
          console.error(`\n  Could not reach coordinator: ${msg}\n  Check your internet connection or try again.`);
        }
        process.exit(1);
      }

      console.log(`\n  Registered as @${username}. Starting worker...`);
      console.log('  Watching for tasks — contributing to any matching open source project.');
      console.log('  To focus on specific projects: tah project pin <owner/repo>\n');

      const workerBin = findWorkerBin();
      const child = spawn(process.execPath, [workerBin], { stdio: 'inherit', env: { ...process.env } });
      await new Promise<void>((resolve) => child.on('exit', () => resolve()));
      process.exit(child.exitCode ?? 1);
    });
}
