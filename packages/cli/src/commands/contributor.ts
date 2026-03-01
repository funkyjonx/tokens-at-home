import { Command } from 'commander';
import { loadConfig, saveConfig, requireAuth } from '../config.js';
import { TahApiClient } from '../api.js';
import type { Contributor, Pledge, Task } from '@tah/shared';
import { createInterface } from 'readline';

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function contributorCommand(): Command {
  const cmd = new Command('contributor').description('Manage contributor profile');

  cmd
    .command('register')
    .description('Register as a contributor')
    .option('--coordinator <url>', 'Coordinator URL', process.env['TAH_COORDINATOR_URL'] ?? 'http://localhost:3000')
    .option('--username <u>', 'GitHub username')
    .option('--languages <l>', 'Comma-separated languages', 'typescript')
    .option('--autonomy <a>', 'full | review_before_pr', 'review_before_pr')
    .action(async (opts: {
      coordinator: string;
      username?: string;
      languages: string;
      autonomy: string;
    }) => {
      const username = opts.username ?? await prompt('GitHub username: ');
      if (!username) {
        console.error('Username required');
        process.exit(1);
      }

      const api = new TahApiClient(opts.coordinator);
      const result = await api.post<{ contributor: Contributor; token: string }>('/contributors', {
        githubUsername: username,
        languages: opts.languages.split(',').map((l) => l.trim()),
        autonomy: opts.autonomy,
        maxConcurrent: 1,
      });

      const config = loadConfig();
      saveConfig({
        ...config,
        coordinatorUrl: opts.coordinator,
        contributorId: result.contributor.id,
        authToken: result.token,
        // Use the coordinator's authoritative autonomy value (new contributors are
        // locked to review_before_pr regardless of what was requested)
        autonomy: result.contributor.autonomy as 'full' | 'review_before_pr',
        githubUsername: result.contributor.githubUsername,
      });

      console.log(`Registered as contributor: ${result.contributor.githubUsername}`);
      console.log(`ID: ${result.contributor.id}`);
      console.log(`Autonomy: ${result.contributor.autonomy}`);
      console.log(`Auth token saved to ~/.tokens-at-home/config.json`);
      console.log('\nRun `tah daemon start` to begin contributing.');
    });

  cmd
    .command('profile')
    .description('Show your contributor profile')
    .action(async () => {
      const config = loadConfig();
      requireAuth(config);
      const api = new TahApiClient(config.coordinatorUrl, config.authToken);
      const contributor = await api.get<Contributor>('/contributors/me');

      console.log(`GitHub: ${contributor.githubUsername}`);
      console.log(`ID: ${contributor.id}`);
      console.log(`Languages: ${contributor.languages.join(', ')}`);
      console.log(`Autonomy: ${contributor.autonomy}`);
      console.log(`Trust score: ${contributor.trustScore}`);
      console.log(`Available: ${contributor.available}`);
      console.log(`Max concurrent: ${contributor.maxConcurrent}`);
    });

  cmd
    .command('available')
    .description('Mark yourself as available to receive tasks')
    .action(async () => {
      const config = loadConfig();
      requireAuth(config);
      const api = new TahApiClient(config.coordinatorUrl, config.authToken);
      await api.put('/contributors/me/available', { available: true });
      console.log('You are now available for task assignment.');
    });

  cmd
    .command('unavailable')
    .description('Mark yourself as unavailable')
    .action(async () => {
      const config = loadConfig();
      requireAuth(config);
      const api = new TahApiClient(config.coordinatorUrl, config.authToken);
      await api.put('/contributors/me/available', { available: false });
      console.log('You are now marked as unavailable.');
    });

  cmd
    .command('pledge')
    .description('Pledge capacity to a project')
    .argument('<project-id>', 'Project ID to pledge to')
    .argument('<budget>', 'Budget percentage (e.g. 80 for 80%)')
    .action(async (projectId: string, budget: string) => {
      const config = loadConfig();
      requireAuth(config);
      const api = new TahApiClient(config.coordinatorUrl, config.authToken);

      const pledge = await api.post<Pledge>('/contributors/me/pledges', {
        projectId,
        budgetPercent: parseFloat(budget),
      });

      console.log(`Pledged ${pledge.budgetPercent}% budget to project ${pledge.projectId}`);
    });

  cmd
    .command('pledges')
    .description('List your active pledges')
    .action(async () => {
      const config = loadConfig();
      requireAuth(config);
      const api = new TahApiClient(config.coordinatorUrl, config.authToken);
      const pledges = await api.get<Pledge[]>('/contributors/me/pledges');

      if (pledges.length === 0) {
        console.log('No active pledges.');
        return;
      }

      for (const p of pledges) {
        const status = p.active ? 'active' : 'inactive';
        console.log(`[${p.id}] Project: ${p.projectId} — ${p.budgetPercent}% (${status})`);
      }
    });

  return cmd;
}
