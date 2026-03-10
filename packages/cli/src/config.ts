import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.tokens-at-home');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export interface CliConfig {
  coordinatorUrl: string;
  contributorId?: string;
  authToken?: string;
  pollIntervalMs?: number;
  workDir?: string;
  logDir?: string;
  githubUsername?: string;
}

export const DEFAULT_COORDINATOR_URL = process.env['TAH_COORDINATOR_URL'] ?? 'https://tokens-at-home.fly.dev';

export function loadConfig(): CliConfig {
  if (!existsSync(CONFIG_PATH)) {
    return { coordinatorUrl: DEFAULT_COORDINATOR_URL };
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as CliConfig;
}

export function saveConfig(config: CliConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

export function requireAuth(config: CliConfig): asserts config is CliConfig & { authToken: string; contributorId: string } {
  if (!config.authToken || !config.contributorId) {
    console.error('Not registered. Run `tah contributor register` first.');
    process.exit(1);
  }
}
