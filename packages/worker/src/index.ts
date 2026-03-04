import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import { WorkerConfigSchema } from '@tah/shared';
import { CoordinatorClient } from './poller.js';
import { executeTask, type ExecutionResult } from './executor.js';
import { humanReview } from './reviewer.js';
import { createPr } from './pr.js';
import { DEFAULT_WORK_DIR, DEFAULT_LOG_DIR } from './sandbox.js';
import { loadConfig } from './config.js';

const POLL_INTERVAL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 60_000;

let running = true;
let currentHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

process.on('SIGINT', () => {
  console.log('\n[worker] Shutting down...');
  running = false;
  if (currentHeartbeatTimer) clearInterval(currentHeartbeatTimer);
  process.exit(0);
});

process.on('SIGTERM', () => {
  running = false;
  if (currentHeartbeatTimer) clearInterval(currentHeartbeatTimer);
});

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

  const config = await loadConfig(configPath);

  const workDir = config.workDir ?? DEFAULT_WORK_DIR;
  const logDir = config.logDir ?? DEFAULT_LOG_DIR;
  mkdirSync(workDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  const client = new CoordinatorClient(config);

  // Warn if contributor has no active pledges of any kind — they'll never receive tasks
  const [pledges, genericPledges] = await Promise.all([
    client.getPledges(),
    client.getGenericPledges(),
  ]);
  const activePledges = pledges.filter((p) => p.active);
  const activeGenericPledges = genericPledges.filter((p) => p.active);
  if (activePledges.length === 0 && activeGenericPledges.length === 0) {
    console.warn('[worker] Warning: you have no active pledges. Run `tah contributor pledge <project-id> <max-tasks>` or `tah contributor pledge-any <max-tasks>` to pledge capacity.');
  }

  console.log('[worker] Started. Polling for tasks...');
  await client.setAvailable(true);

  let emptyPolls = 0;

  while (running) {
    try {
      const assignment = await client.getNextTask();

      if (!assignment) {
        emptyPolls++;
        if (emptyPolls % 5 === 0) {
          console.log(`[worker] Waiting for tasks... (${emptyPolls} polls, no match yet — check your pledges with \`tah contributor pledges\`)`);
        }
        await sleep(config.pollIntervalMs ?? POLL_INTERVAL_MS);
        continue;
      }

      emptyPolls = 0;

      const { task, issue, project } = assignment;
      console.log(`[worker] Task received: ${task.id} (${project.githubOwner}/${project.githubRepo}#${issue.githubNumber})`);

      // Start heartbeat loop
      currentHeartbeatTimer = setInterval(async () => {
        try {
          const hb = await client.sendHeartbeat(task.id);
          if (hb.cancel) {
            console.log('[worker] Coordinator requested task cancellation');
            running = false;
          }
        } catch (err) {
          console.error('[worker] Heartbeat error:', err);
        }
      }, HEARTBEAT_INTERVAL_MS);

      let result: ExecutionResult | undefined;
      try {
        // Update status: cloning
        await client.updateStatus(task.id, 'cloning');

        result = await executeTask(task, issue, project, workDir, logDir);

        if (!result.success || !result.claudeOutput || !result.repoPath) {
          throw new Error(result.error ?? 'Execution failed');
        }

        // Human review if required (default: review_before_pr)
        const needsReview = (config.autonomy ?? 'review_before_pr') !== 'full';

        let approved = true;
        if (needsReview) {
          await client.updateStatus(task.id, 'review');
          const decision = await humanReview(result.repoPath, issue, project);
          approved = decision.approved;
          if (!approved) {
            throw new Error(decision.reason ?? 'Rejected during review');
          }
        }

        // Submit PR
        await client.updateStatus(task.id, 'submitting');
        const pr = await createPr(
          result.repoPath,
          task,
          issue,
          project,
          result.claudeOutput.summary,
          config.githubUsername ?? '',
        );

        // Report completion
        await client.completeTask(
          task.id,
          pr.prUrl,
          result.claudeOutput.tokensUsed,
          result.claudeOutput.summary,
        );

        console.log(`[worker] Task ${task.id} completed. PR: ${pr.prUrl}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[worker] Task ${task.id} failed: ${msg}`);
        await client.failTask(task.id, msg);
      } finally {
        if (currentHeartbeatTimer) {
          clearInterval(currentHeartbeatTimer);
          currentHeartbeatTimer = null;
        }
        // Clean up work directory to avoid unbounded disk growth
        if (result?.taskWorkDir) {
          try {
            rmSync(result.taskWorkDir, { recursive: true, force: true });
          } catch {
            // non-fatal — log dir is kept
          }
        }
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
