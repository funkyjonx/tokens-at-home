import { Command } from 'commander';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { loadConfig, requireAuth } from '../config.js';

export function workerCommand(): Command {
  const cmd = new Command('worker').description('Run the contributor worker');

  cmd
    .command('start')
    .description('Start the worker (runs in the foreground — keep this terminal open)')
    .action(async () => {
      const config = loadConfig();
      requireAuth(config);

      const workerBin = findWorkerBin();
      const child = spawn(process.execPath, [workerBin], {
        stdio: 'inherit',
        env: { ...process.env },
      });

      await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    });

  return cmd;
}

function findWorkerBin(): string {
  const thisDir = dirname(new URL(import.meta.url).pathname);
  const candidates = [
    // Development: packages/cli/dist → packages/worker/dist
    join(thisDir, '../../worker/dist/index.js'),
    // Installed globally: node_modules/@tah/cli/dist → node_modules/@tah/worker/dist
    join(thisDir, '../../../@tah/worker/dist/index.js'),
    // Running from monorepo root
    join(process.cwd(), 'packages', 'worker', 'dist', 'index.js'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  // Fall back to source (requires tsx in PATH)
  return join(process.cwd(), 'packages', 'worker', 'src', 'index.ts');
}
