import { Command } from 'commander';
import { loadConfig, requireAuth } from '../config.js';
import { TahApiClient } from '../api.js';
import type { Task } from '@tah/shared';

export function taskCommand(): Command {
  const cmd = new Command('task').description('Manage task assignments');

  cmd
    .command('assign')
    .description('Manually assign an issue to a contributor (MVP: no auto-matching)')
    .argument('<issue-id>', 'Issue ID')
    .argument('<contributor-id>', 'Contributor ID')
    .action(async (issueId: string, contributorId: string) => {
      const config = loadConfig();
      requireAuth(config);
      const api = new TahApiClient(config.coordinatorUrl, config.authToken);

      const task = await api.post<Task>('/tasks/assign', { issueId, contributorId });
      console.log(`Task created: ${task.id}`);
      console.log(`Status: ${task.status}`);
      console.log(`The contributor's worker will pick this up on its next poll.`);
    });

  cmd
    .command('list')
    .description('List all tasks')
    .action(async () => {
      const config = loadConfig();
      requireAuth(config);
      const api = new TahApiClient(config.coordinatorUrl, config.authToken);
      const tasks = await api.get<Task[]>('/tasks');

      if (tasks.length === 0) {
        console.log('No tasks.');
        return;
      }

      for (const t of tasks) {
        const pr = t.prUrl ? ` → ${t.prUrl}` : '';
        const tokens = t.tokensUsed ? ` (${t.tokensUsed.toLocaleString()} tokens)` : '';
        console.log(`[${t.id}] ${t.status}${tokens}${pr}`);
      }
    });

  return cmd;
}
