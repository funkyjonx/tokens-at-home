import { Command } from 'commander';
import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { loadConfig, requireAuth } from '../config.js';

const PID_FILE = join(homedir(), '.tokens-at-home', 'daemon.pid');

export function daemonCommand(): Command {
  const cmd = new Command('daemon').description('Manage the contributor daemon');

  cmd
    .command('start')
    .description('Start the daemon (background process)')
    .action(() => {
      const config = loadConfig();
      requireAuth(config);

      if (existsSync(PID_FILE)) {
        const pid = parseInt(readFileSync(PID_FILE, 'utf-8'), 10);
        try {
          process.kill(pid, 0);
          console.log(`Daemon already running (PID ${pid})`);
          return;
        } catch {
          // stale PID file
          unlinkSync(PID_FILE);
        }
      }

      const daemonBin = findDaemonBin();
      const child = spawn(process.execPath, [daemonBin], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
      });
      child.unref();

      writeFileSync(PID_FILE, String(child.pid), 'utf-8');
      console.log(`Daemon started (PID ${child.pid})`);
      console.log(`Logs: ~/.tokens-at-home/logs/`);
    });

  cmd
    .command('stop')
    .description('Stop the daemon')
    .action(() => {
      if (!existsSync(PID_FILE)) {
        console.log('Daemon is not running.');
        return;
      }

      const pid = parseInt(readFileSync(PID_FILE, 'utf-8'), 10);
      try {
        process.kill(pid, 'SIGTERM');
        unlinkSync(PID_FILE);
        console.log(`Daemon stopped (PID ${pid})`);
      } catch (err) {
        console.error(`Could not stop daemon: ${err instanceof Error ? err.message : err}`);
        unlinkSync(PID_FILE);
      }
    });

  cmd
    .command('status')
    .description('Show daemon status')
    .action(() => {
      if (!existsSync(PID_FILE)) {
        console.log('Status: stopped');
        return;
      }

      const pid = parseInt(readFileSync(PID_FILE, 'utf-8'), 10);
      try {
        process.kill(pid, 0);
        console.log(`Status: running (PID ${pid})`);
        console.log(`Logs: ~/.tokens-at-home/logs/`);
      } catch {
        console.log('Status: stopped (stale PID file)');
        unlinkSync(PID_FILE);
      }
    });

  cmd
    .command('run')
    .description('Run the daemon in the foreground (useful for testing)')
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
