import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { CoordinatorClient } from './poller.js';
import { executeTask, type ExecutionResult } from './executor.js';
import { humanReview } from './reviewer.js';
import { createPr } from './pr.js';
import { DEFAULT_WORK_DIR, DEFAULT_LOG_DIR } from './sandbox.js';
import { loadConfig } from './config.js';

const POLL_INTERVAL_MS = 30_000;
const PROGRESS_INTERVAL_MS = 60_000;

function preflight(): void {
  try {
    execFileSync('claude', ['--version'], { timeout: 5_000, stdio: 'ignore' });
  } catch {
    console.error("'claude' CLI not found. Install it from https://claude.ai/claude-code");
    process.exit(1);
  }

  try {
    execFileSync('gh', ['auth', 'status'], { timeout: 5_000, stdio: 'ignore' });
  } catch {
    console.error("'gh' CLI is not authenticated. Run 'gh auth login' first.");
    process.exit(1);
  }
}

export async function startWorker(configPath?: string) {
  preflight();

  const config = loadConfig(configPath);

  const workDir = config.workDir ?? DEFAULT_WORK_DIR;
  const logDir = config.logDir ?? DEFAULT_LOG_DIR;
  mkdirSync(workDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  const client = new CoordinatorClient(config);

  let running = true;
  let currentProgressTimer: ReturnType<typeof setInterval> | null = null;

  // Register signal handlers inside startWorker so client is in scope
  const shutdown = async (signal: string) => {
    console.log(`\n[worker] ${signal} received, shutting down...`);
    running = false;
    if (currentProgressTimer) {
      clearInterval(currentProgressTimer);
      currentProgressTimer = null;
    }
    try {
      await client.setAvailable(false);
    } catch { /* best effort */ }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  console.log('[worker] Started. Polling for tasks...');
  await client.setAvailable(true);

  let emptyPolls = 0;

  while (running) {
    try {
      const assignment = await client.getNextTask();

      if (!assignment) {
        emptyPolls++;
        if (emptyPolls % 5 === 0) {
          console.log(`[worker] Waiting for tasks... (${emptyPolls} polls — pin projects with \`tah project pin <owner/repo>\`)`);
        }
        await sleep(config.pollIntervalMs ?? POLL_INTERVAL_MS);
        continue;
      }

      emptyPolls = 0;

      const { task, issue, project } = assignment;
      console.log(`[worker] Task received: ${task.id} (${project.githubOwner}/${project.githubRepo}#${issue.githubNumber})`);

      let currentPhase = 'cloning';
      let currentTokens = 0;
      const taskStartMs = Date.now();

      currentProgressTimer = setInterval(async () => {
        try {
          await client.sendProgress(task.id, currentPhase, currentTokens, Date.now() - taskStartMs);
        } catch (err) {
          console.error('[worker] Progress update error:', err);
        }
      }, PROGRESS_INTERVAL_MS);

      let result: ExecutionResult | undefined;
      try {
        console.log(`[1/4] Cloning...`);
        await client.sendProgress(task.id, 'cloning');

        result = await executeTask(task, issue, project, workDir, logDir, (phase) => {
          currentPhase = phase;
          if (phase === 'working') {
            console.log(`      clone done (${Math.round((Date.now() - taskStartMs) / 1000)}s)`);
            console.log(`[2/4] Running Claude...`);
          }
        });

        if (!result.success || !result.claudeOutput || !result.repoPath) {
          throw new Error(result.error ?? 'Execution failed');
        }

        currentTokens = result.claudeOutput.tokensUsed;

        console.log(`[3/4] Human review...`);
        currentPhase = 'review';
        await client.sendProgress(task.id, 'review', currentTokens, Date.now() - taskStartMs);
        const decision = await humanReview(result.repoPath, issue, project);
        if (!decision.approved) {
          throw new Error(decision.reason ?? 'Rejected during review');
        }

        console.log(`[4/4] Submitting PR...`);
        currentPhase = 'submitting';
        await client.sendProgress(task.id, 'submitting', currentTokens, Date.now() - taskStartMs);
        const pr = await createPr(
          result.repoPath,
          task,
          issue,
          project,
          result.claudeOutput.summary,
          config.githubUsername ?? '',
        );

        await client.completeTask(
          task.id,
          pr.prUrl,
          result.claudeOutput.tokensUsed,
          result.claudeOutput.summary,
        );

        console.log(`[ok]  Done -> ${pr.prUrl}`);
        console.log(`      ${result.claudeOutput.tokensUsed.toLocaleString('en-US')} tokens donated`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[worker] Task ${task.id} failed: ${msg}`);
        try {
          await client.failTask(task.id, msg, currentTokens || undefined);
        } catch (failErr) {
          console.error('[worker] Could not report task failure to coordinator:', failErr);
        }
      } finally {
        if (currentProgressTimer) {
          clearInterval(currentProgressTimer);
          currentProgressTimer = null;
        }
        const taskWorkDir = join(workDir, task.id);
        try {
          rmSync(taskWorkDir, { recursive: true, force: true });
        } catch { /* non-fatal */ }
      }
    } catch (err) {
      console.error('[worker] Poll error:', err);
      await sleep(config.pollIntervalMs ?? POLL_INTERVAL_MS);
    }
  }

  await client.setAvailable(false);
  console.log('[worker] Stopped.');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Entry point when run directly
const isMain = process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index.ts');
if (isMain) {
  startWorker().catch((err) => {
    console.error('[worker] Fatal:', err);
    process.exit(1);
  });
}
