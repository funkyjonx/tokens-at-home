import { spawnSync, execSync, type SpawnSyncReturns } from 'child_process';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { Issue, Project, Task } from '@tah/shared';
import { buildPrompt } from '@tah/shared';
import { buildSandboxConfig, formatAllowedTools } from './sandbox.js';

export interface ClaudeOutput {
  summary: string;
  tokensUsed: number;
  exitCode: number;
  rawOutput: string;
}

export interface ExecutionResult {
  success: boolean;
  claudeOutput?: ClaudeOutput;
  repoPath?: string;
  error?: string;
}

function log(logFile: string, message: string) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  appendFileSync(logFile, line, 'utf-8');
  process.stdout.write(line);
}

function run(cmd: string, cwd?: string): SpawnSyncReturns<Buffer> {
  return spawnSync('sh', ['-c', cmd], {
    cwd,
    stdio: 'pipe',
    encoding: 'buffer',
  });
}

export async function executeTask(
  task: Task,
  issue: Issue,
  project: Project,
  workBaseDir?: string,
  logBaseDir?: string,
): Promise<ExecutionResult> {
  const sandbox = buildSandboxConfig(task.id, issue.taskType, workBaseDir, logBaseDir);

  // Create directories
  mkdirSync(sandbox.taskWorkDir, { recursive: true });
  const logDir = sandbox.logFile.replace(/\/[^/]+$/, '');
  mkdirSync(logDir, { recursive: true });

  log(sandbox.logFile, `Starting task ${task.id}`);
  log(sandbox.logFile, `Issue: ${project.githubOwner}/${project.githubRepo}#${issue.githubNumber}`);

  // Clone the repo
  const repoUrl = `https://github.com/${project.githubOwner}/${project.githubRepo}.git`;
  log(sandbox.logFile, `Cloning ${repoUrl}`);

  const cloneResult = run(
    `git clone --depth 50 "${repoUrl}" repo`,
    sandbox.taskWorkDir,
  );

  if (cloneResult.status !== 0) {
    const err = cloneResult.stderr.toString();
    log(sandbox.logFile, `Clone failed: ${err}`);
    return { success: false, error: `Clone failed: ${err}` };
  }

  const repoPath = join(sandbox.taskWorkDir, 'repo');
  log(sandbox.logFile, `Cloned to ${repoPath}`);

  // Create a working branch
  const branchName = `tah/issue-${issue.githubNumber}`;
  const branchResult = run(
    `git checkout -b "${branchName}"`,
    repoPath,
  );

  if (branchResult.status !== 0) {
    log(sandbox.logFile, `Branch creation failed: ${branchResult.stderr.toString()}`);
    return { success: false, error: 'Could not create working branch' };
  }

  // Build the prompt
  const prompt = buildPrompt({ issue, project, repoPath });
  const promptFile = join(sandbox.taskWorkDir, 'prompt.txt');
  writeFileSync(promptFile, prompt, 'utf-8');
  log(sandbox.logFile, `Prompt written (${prompt.length} chars)`);

  // Invoke claude -p
  const allowedTools = formatAllowedTools(sandbox.allowedTools);
  const claudeCmd = [
    'claude',
    '--output-format', 'json',
    '--allowedTools', `"${allowedTools}"`,
    '-p', `"$(cat ${promptFile})"`,
  ].join(' ');

  log(sandbox.logFile, `Invoking: claude --output-format json --allowedTools "..." -p "..."`);

  const claudeResult = run(claudeCmd, repoPath);
  const rawOutput = claudeResult.stdout.toString();
  const exitCode = claudeResult.status ?? 1;

  // Write raw output to log
  writeFileSync(join(sandbox.taskWorkDir, 'claude-output.json'), rawOutput, 'utf-8');

  if (exitCode !== 0) {
    const err = claudeResult.stderr.toString();
    log(sandbox.logFile, `Claude exited with code ${exitCode}: ${err}`);
    return { success: false, error: `Claude failed (exit ${exitCode}): ${err}` };
  }

  // Parse Claude's JSON output
  const { summary, tokensUsed } = parseClaudeOutput(rawOutput);
  log(sandbox.logFile, `Claude completed. Summary: ${summary}`);
  log(sandbox.logFile, `Tokens used: ${tokensUsed}`);

  return {
    success: true,
    claudeOutput: { summary, tokensUsed, exitCode, rawOutput },
    repoPath,
  };
}

function parseClaudeOutput(rawOutput: string): { summary: string; tokensUsed: number } {
  try {
    // Claude --output-format json returns a JSON object with the result
    const parsed = JSON.parse(rawOutput) as {
      result?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const resultText = parsed.result ?? '';
    const tokensUsed =
      (parsed.usage?.input_tokens ?? 0) + (parsed.usage?.output_tokens ?? 0);

    // Try to extract the JSON summary from Claude's output
    const jsonMatch = resultText.match(/```json\n([\s\S]*?)\n```/);
    if (jsonMatch?.[1]) {
      try {
        const inner = JSON.parse(jsonMatch[1]) as { summary?: string };
        return {
          summary: inner.summary ?? resultText.slice(0, 200),
          tokensUsed,
        };
      } catch {
        // fall through
      }
    }

    return {
      summary: resultText.slice(0, 500) || 'Task completed',
      tokensUsed,
    };
  } catch {
    return { summary: 'Task completed (could not parse output)', tokensUsed: 0 };
  }
}
