import type { TaskType } from '@tah/shared';
import { ALLOWED_TOOLS } from '@tah/shared';
import { homedir } from 'os';
import { join } from 'path';

export const DEFAULT_WORK_DIR = join(homedir(), '.tokens-at-home', 'work');
export const DEFAULT_LOG_DIR = join(homedir(), '.tokens-at-home', 'logs');

export interface SandboxConfig {
  workDir: string;
  taskWorkDir: string;
  allowedTools: string[];
  logFile: string;
}

export function buildSandboxConfig(
  taskId: string,
  taskType: TaskType,
  workDir = DEFAULT_WORK_DIR,
  logDir = DEFAULT_LOG_DIR,
): SandboxConfig {
  return {
    workDir,
    taskWorkDir: join(workDir, taskId),
    allowedTools: ALLOWED_TOOLS[taskType] ?? ALLOWED_TOOLS['code'],
    logFile: join(logDir, `${taskId}.log`),
  };
}

// Format tools list for the --allowedTools CLI flag
export function formatAllowedTools(tools: string[]): string {
  return tools.join(',');
}
