import { Command } from 'commander';
import { loadConfig, requireAuth } from '../config.js';
import { TahApiClient } from '../api.js';
import type { Contributor, PublicContributor } from '@tah/shared';

export function contributorCommand(): Command {
  const cmd = new Command('contributor').description('Manage contributor profile');

  cmd
    .command('profile')
    .description('Show your contributor profile')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      const config = loadConfig();
      requireAuth(config);
      const api = new TahApiClient(config.coordinatorUrl, config.authToken);
      const contributor = await api.get<Contributor>('/contributors/me');

      if (opts.json) {
        console.log(JSON.stringify(contributor, null, 2));
        return;
      }

      console.log(`GitHub: ${contributor.githubUsername}`);
      console.log(`Languages: ${contributor.languages.join(', ')}`);
      console.log(`Available: ${contributor.available}`);
      console.log(`Max concurrent: ${contributor.maxConcurrent}`);
      console.log(`Max complexity: ${contributor.maxComplexity}`);
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
    .command('search')
    .description('Search for contributors by username')
    .argument('<query>', 'Search term (matches GitHub username)')
    .option('--language <lang>', 'Filter by language')
    .option('--sort <s>', 'Sort by: tasks | tokens', 'tasks')
    .action(async (query: string, opts: { language?: string; sort: string }) => {
      const config = loadConfig();
      const api = new TahApiClient(config.coordinatorUrl);

      const params = new URLSearchParams({ q: query, sort: opts.sort });
      if (opts.language) params.set('language', opts.language);
      const results = await api.get<PublicContributor[]>(`/contributors?${params}`);

      if (results.length === 0) {
        console.log('No contributors found.');
        return;
      }

      console.log(`${'Username'.padEnd(24)}${'Languages'.padEnd(28)}${'Tasks'.padEnd(8)}Tokens Donated`);
      console.log('-'.repeat(72));
      for (const c of results) {
        const username = c.githubUsername.padEnd(24);
        const langs = c.languages.join(', ').substring(0, 26).padEnd(28);
        const tasks = String(c.tasksCompleted).padEnd(8);
        console.log(`${username}${langs}${tasks}${c.totalTokensDonated.toLocaleString('en-US')}`);
      }
    });

  return cmd;
}
