import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { WorkerConfigSchema, type WorkerConfig } from '@tah/shared';

export const DEFAULT_CONFIG_PATH = join(homedir(), '.tokens-at-home', 'config.json');
export const DEFAULT_COORDINATOR_URL = 'http://localhost:3000';

export function loadConfig(configPath = DEFAULT_CONFIG_PATH): WorkerConfig {
  if (!existsSync(configPath)) {
    throw new Error(
      `Config not found at ${configPath}. Run 'tah contributor register' first.`,
    );
  }

  const raw = readFileSync(configPath, 'utf-8');
  const json = JSON.parse(raw);
  return WorkerConfigSchema.parse(json);
}

export function buildDefaultConfig(
  coordinatorUrl: string,
  contributorId: string,
  authToken: string,
): WorkerConfig {
  const base = join(homedir(), '.tokens-at-home');
  return WorkerConfigSchema.parse({
    coordinatorUrl,
    contributorId,
    authToken,
    pollIntervalMs: 30_000,
    workDir: join(base, 'work'),
    logDir: join(base, 'logs'),
  });
}
