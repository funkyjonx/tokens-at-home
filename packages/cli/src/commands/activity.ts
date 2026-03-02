import { Command } from 'commander';
import { loadConfig } from '../config.js';
import { TahApiClient } from '../api.js';
import type { ActivityEvent } from '@tah/shared';

export function activityCommand(): Command {
  return new Command('activity')
    .description('Show recent project and contributor activity')
    .option('-n, --limit <n>', 'Max events to show', '50')
    .action(async (opts: { limit: string }) => {
      const config = loadConfig();
      const api = new TahApiClient(config.coordinatorUrl);
      const events = await api.get<ActivityEvent[]>('/events');

      if (events.length === 0) {
        console.log('No activity yet.');
        return;
      }

      const limit = parseInt(opts.limit, 10);
      const shown = events.slice(0, limit);

      for (const e of shown) {
        const date = e.ts.replace('T', ' ').slice(0, 16);
        switch (e.type) {
          case 'project_registered':
            console.log(`${date}  PROJECT REGISTERED  ${e.project}  (by ${e.actor})`);
            break;
          case 'contributor_joined':
            console.log(`${date}  CONTRIBUTOR JOINED  ${e.actor}`);
            break;
          case 'pledge_created':
            console.log(`${date}  PLEDGE              ${e.actor} → ${e.project}  (up to ${e.maxTasks} ${e.maxComplexity} tasks)`);
            break;
          case 'task_completed':
            console.log(`${date}  TASK COMPLETED      ${e.actor}  #${e.issueNumber}  ${e.tokensUsed.toLocaleString()} tokens  ${e.prUrl}`);
            break;
          case 'task_failed':
            console.log(`${date}  TASK FAILED         ${e.actor}  #${e.issueNumber}${e.errorDetails ? `  (${e.errorDetails.slice(0, 60)})` : ''}`);
            break;
        }
      }

      if (events.length > limit) {
        console.log(`\n(${events.length - limit} more — use --limit to see more)`);
      }
    });
}
