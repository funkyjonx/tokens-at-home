import { Command } from 'commander';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { loadConfig, DEFAULT_COORDINATOR_URL } from '../config.js';
import { TahApiClient } from '../api.js';

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
    .description('Start the worker (requires prior registration via tah contributor register)')
    .option('--coordinator <url>', 'Coordinator URL', DEFAULT_COORDINATOR_URL)
    .action(async (opts: { coordinator: string }) => {
      const config = loadConfig();
      const coordinatorUrl = opts.coordinator ?? config.coordinatorUrl;

      // Require prior registration
      if (!config.authToken || !config.contributorId) {
        console.error('Not registered. Run `tah contributor register` first.');
        process.exit(1);
      }

      // Verify token is still valid
      const api = new TahApiClient(coordinatorUrl, config.authToken);
      try {
        await api.get('/contributors/me');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('(401)')) {
          console.error('\n  Your session has expired. Run `tah contributor register` to re-register.\n');
        } else {
          console.error(`  Could not reach coordinator: ${msg}`);
        }
        process.exit(1);
      }

      console.log('Config found. Starting worker...');
      const workerBin = findWorkerBin();
      const child = spawn(process.execPath, [workerBin], { stdio: 'inherit', env: { ...process.env } });
      await new Promise<void>((resolve) => child.on('exit', () => resolve()));
      process.exit(child.exitCode ?? 1);
    });
}
