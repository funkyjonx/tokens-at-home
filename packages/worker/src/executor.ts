import { spawn, spawnSync, type SpawnSyncReturns } from 'child_process';
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
  taskWorkDir?: string;
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

  // Invoke claude -p with direct args (no shell interpolation)
  const allowedTools = formatAllowedTools(sandbox.allowedTools);
  const promptContent = readFileSync(promptFile, 'utf-8');

  log(sandbox.logFile, `Invoking Claude...`);

  const { rawOutput, exitCode, stderr } = await runClaude(
    ['--output-format', 'stream-json', '--allowedTools', allowedTools, '-p', promptContent],
    repoPath,
    sandbox.logFile,
  );

  // Write raw output to log
  writeFileSync(join(sandbox.taskWorkDir, 'claude-output.json'), rawOutput, 'utf-8');

  if (exitCode !== 0) {
    log(sandbox.logFile, `Claude exited with code ${exitCode}: ${stderr}`);
    return { success: false, error: `Claude failed (exit ${exitCode}): ${stderr}` };
  }

  // Parse Claude's JSON output
  const { summary, tokensUsed } = parseClaudeOutput(rawOutput);
  log(sandbox.logFile, `Claude completed. Summary: ${summary}`);
  log(sandbox.logFile, `Tokens used: ${tokensUsed}`);

  return {
    success: true,
    claudeOutput: { summary, tokensUsed, exitCode, rawOutput },
    repoPath,
    taskWorkDir: sandbox.taskWorkDir,
  };
}

async function runClaude(
  args: string[],
  cwd: string,
  logFile: string,
): Promise<{ rawOutput: string; exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const lines: string[] = [];
    const stderrChunks: Buffer[] = [];
    let lineBuffer = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString('utf-8');
      const parts = lineBuffer.split('\n');
      lineBuffer = parts.pop() ?? '';
      for (const line of parts) {
        if (!line.trim()) continue;
        lines.push(line);
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          const progress = extractProgress(event);
          if (progress) log(logFile, progress);
        } catch { /* non-JSON line */ }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error('Claude timed out after 10 minutes'));
    }, 10 * 60 * 1000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      resolve({
        rawOutput: lines.join('\n'),
        exitCode: code ?? 1,
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function extractProgress(event: Record<string, unknown>): string | null {
  if (event['type'] !== 'assistant') return null;
  const msg = event['message'] as { content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }> } | undefined;
  for (const block of msg?.content ?? []) {
    if (block.type === 'tool_use' && block.name) {
      return formatToolCall(block.name, block.input ?? {});
    }
  }
  return null;
}

function formatToolCall(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read':    return `  Read    ${input['file_path'] ?? ''}`;
    case 'Write':   return `  Write   ${input['file_path'] ?? ''}`;
    case 'Edit':    return `  Edit    ${input['file_path'] ?? ''}`;
    case 'Glob':    return `  Glob    ${input['pattern'] ?? ''}`;
    case 'Grep':    return `  Grep    ${input['pattern'] ?? ''}`;
    case 'Bash':    return `  Bash    ${String(input['command'] ?? '').split('\n')[0].slice(0, 80)}`;
    default:        return `  ${name}`;
  }
}

function parseClaudeOutput(rawOutput: string): { summary: string; tokensUsed: number } {
  if (!rawOutput.trim()) {
    throw new Error('Claude produced no output');
  }

  // stream-json format: find the result event (last line with type=result)
  for (const line of rawOutput.split('\n').reverse()) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event['type'] !== 'result') continue;

      const resultText = String(event['result'] ?? '');
      const usage = event['usage'] as { input_tokens?: number; output_tokens?: number } | undefined;
      const tokensUsed = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);

      if (tokensUsed === 0) {
        throw new Error('Claude reported 0 tokens used — output may be malformed');
      }

      // Try to extract the JSON summary from Claude's result text
      const jsonMatch = resultText.match(/```json\n([\s\S]*?)\n```/);
      if (jsonMatch?.[1]) {
        try {
          const inner = JSON.parse(jsonMatch[1]) as { summary?: string };
          return { summary: inner.summary ?? resultText.slice(0, 500), tokensUsed };
        } catch { /* fall through */ }
      }

      return { summary: resultText.slice(0, 500) || 'Task completed', tokensUsed };
    } catch (e) {
      if (e instanceof Error && e.message.includes('0 tokens')) throw e;
      // not JSON or not the result event, keep scanning
    }
  }

  throw new Error(`No result event found in Claude output (got ${rawOutput.slice(0, 200)})`);
}
