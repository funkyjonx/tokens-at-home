import { Command } from 'commander';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { loadConfig, requireAuth } from '../config.js';

export function daemonCommand(): Command {
  const cmd = new Command('daemon').description('Manage the contributor daemon');

  cmd
    .command('start')
    .description('Start the daemon (runs in the foreground — keep this terminal open)')
    .action(async () => {
      const config = loadConfig();
      requireAuth(config);

      const daemonBin = findDaemonBin();
      const child = spawn(process.execPath, [daemonBin], {
        stdio: 'inherit',
        env: { ...process.env },
      });

      await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    });

  return cmd;
}

function findDaemonBin(): string {
  const thisDir = dirname(new URL(import.meta.url).pathname);
  const candidates = [
    // Development: packages/cli/dist → packages/daemon/dist
    join(thisDir, '../../daemon/dist/index.js'),
    // Installed globally: node_modules/@tah/cli/dist → node_modules/@tah/daemon/dist
    join(thisDir, '../../../@tah/daemon/dist/index.js'),
    // Running from monorepo root
    join(process.cwd(), 'packages', 'daemon', 'dist', 'index.js'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  // Fall back to source (requires tsx in PATH)
  return join(process.cwd(), 'packages', 'daemon', 'src', 'index.ts');
}
