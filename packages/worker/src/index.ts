import { mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { WorkerConfigSchema } from '@tah/shared';
import { CoordinatorClient } from './poller.js';
import { executeTask } from './executor.js';
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

export async function startWorker(configPath?: string) {
  const config = await loadConfig(configPath);

  const workDir = config.workDir ?? DEFAULT_WORK_DIR;
  const logDir = config.logDir ?? DEFAULT_LOG_DIR;
  mkdirSync(workDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  const client = new CoordinatorClient(config);

  console.log('[worker] Started. Polling for tasks...');
  await client.setAvailable(true);

  while (running) {
    try {
      const assignment = await client.getNextTask();

      if (!assignment) {
        await sleep(config.pollIntervalMs ?? POLL_INTERVAL_MS);
        continue;
      }

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

      try {
        // Update status: cloning
        await client.updateStatus(task.id, 'cloning');

        const result = await executeTask(task, issue, project, workDir, logDir);

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
