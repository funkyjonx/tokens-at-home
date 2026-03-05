import { Command } from 'commander';
import { loadConfig, saveConfig, requireAuth } from '../config.js';
import { TahApiClient } from '../api.js';
import type { Contributor, GenericPledge, Pledge, Project, PublicContributor, Task, WatchlistEntry } from '@tah/shared';
import { createInterface } from 'readline';
import { execSync } from 'child_process';

function getGithubUsername(): string | null {
  try {
    return execSync('gh api user --jq .login', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

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
    .option('--coordinator <url>', 'Coordinator URL')
    .option('--username <u>', 'GitHub username')
    .option('--languages <l>', 'Comma-separated languages', 'typescript')
    .option('--autonomy <a>', 'full | review_before_pr', 'review_before_pr')
    .action(async (opts: {
      coordinator: string;
      username?: string;
      languages: string;
      autonomy: string;
    }) => {
      let username = opts.username;
      if (!username) {
        const detected = getGithubUsername();
        if (detected) {
          const confirm = await prompt(`Register as ${detected}? [Y/n]: `);
          if (confirm.toLowerCase() === 'n') {
            username = await prompt('GitHub username: ');
          } else {
            username = detected;
          }
        } else {
          username = await prompt('GitHub username: ');
        }
      }

      if (!username) {
        console.error('Username required');
        process.exit(1);
      }

      const config = loadConfig();
      const coordinatorUrl = opts.coordinator ?? config.coordinatorUrl;
      const api = new TahApiClient(coordinatorUrl);
      const result = await api.post<{ contributor: Contributor; token: string }>('/contributors', {
        githubUsername: username,
        languages: opts.languages.split(',').map((l) => l.trim()),
        autonomy: opts.autonomy,
        maxConcurrent: 1,
      });

      saveConfig({
        ...config,
        coordinatorUrl: coordinatorUrl,
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
      if (opts.autonomy === 'full' && result.contributor.autonomy !== 'full') {
        console.log(`Note: new contributors start with review_before_pr. You'll be shown a diff and asked to approve before any PR is submitted. Full autonomy is unlocked after you've had PRs merged.`);
      }
      console.log(`Auth token saved to ~/.tokens-at-home/config.json`);
      console.log('\nRun `tah worker start` to begin contributing.');
    });

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
    .argument('<max-tasks>', 'Number of tasks to complete for this project')
    .option('--max-complexity <c>', 'Max issue complexity to accept: trivial | small | medium | large', 'large')
    .action(async (projectId: string, maxTasksStr: string, opts: { maxComplexity: string }) => {
      const config = loadConfig();
      requireAuth(config);
      const api = new TahApiClient(config.coordinatorUrl, config.authToken);

      const maxTasks = parseInt(maxTasksStr, 10);
      if (isNaN(maxTasks) || maxTasks < 1) {
        console.error('max-tasks must be a positive integer');
        process.exit(1);
      }

      const pledge = await api.post<Pledge>('/contributors/me/pledges', {
        projectId,
        maxTasks,
        maxComplexity: opts.maxComplexity,
      });

      console.log(`Pledged ${pledge.maxTasks} task(s) (up to ${pledge.maxComplexity}) to project ${pledge.projectId}`);
    });

  cmd
    .command('pledges')
    .description('List your active pledges')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      const config = loadConfig();
      requireAuth(config);
      const api = new TahApiClient(config.coordinatorUrl, config.authToken);
      const pledges = await api.get<Pledge[]>('/contributors/me/pledges');

      if (opts.json) {
        console.log(JSON.stringify(pledges, null, 2));
        return;
      }

      if (pledges.length === 0) {
        console.log('No active pledges.');
        return;
      }

      // Fetch project names in parallel, falling back to raw ID on failure
      const projectNames = await Promise.all(
        pledges.map(async (p) => {
          try {
            const proj = await api.get<Project>(`/projects/${p.projectId}`);
            return `${proj.githubOwner}/${proj.githubRepo}`;
          } catch {
            return p.projectId;
          }
        }),
      );

      console.log('Project'.padEnd(30), 'Tasks'.padEnd(10), 'Complexity'.padEnd(15), 'Status');
      console.log('-'.repeat(65));

      for (let i = 0; i < pledges.length; i++) {
        const p = pledges[i]!;
        const name = projectNames[i]!;
        const tasks = `${p.completedTasks ?? 0}/${p.maxTasks}`;
        const status = p.active ? 'active' : 'inactive';
        console.log(
          name.padEnd(30),
          tasks.padEnd(10),
          p.maxComplexity.padEnd(15),
          status,
        );
      }
    });

  cmd
    .command('watch')
    .description('Add a project to your watchlist')
    .argument('<project-id>', 'Project ID to watch')
    .action(async (projectId: string) => {
      const config = loadConfig();
      requireAuth(config);
      const api = new TahApiClient(config.coordinatorUrl, config.authToken);
      await api.post('/contributors/me/watchlist', { projectId });
      console.log(`Project ${projectId} added to watchlist.`);
    });

  cmd
    .command('unwatch')
    .description('Remove a project from your watchlist')
    .argument('<project-id>', 'Project ID to remove')
    .action(async (projectId: string) => {
      const config = loadConfig();
      requireAuth(config);
      const api = new TahApiClient(config.coordinatorUrl, config.authToken);
      await api.delete(`/contributors/me/watchlist/${projectId}`);
      console.log(`Project ${projectId} removed from watchlist.`);
    });

  cmd
    .command('watchlist')
    .description('List your watched projects')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      const config = loadConfig();
      requireAuth(config);
      const api = new TahApiClient(config.coordinatorUrl, config.authToken);
      const entries = await api.get<(WatchlistEntry & { githubOwner: string; githubRepo: string })[]>(
        '/contributors/me/watchlist',
      );

      if (opts.json) {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }

      if (entries.length === 0) {
        console.log('No projects on watchlist.');
        return;
      }

      console.log('Project'.padEnd(40), 'ID');
      console.log('-'.repeat(60));
      for (const e of entries) {
        console.log(`${e.githubOwner}/${e.githubRepo}`.padEnd(40), e.projectId);
      }
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

  cmd
    .command('pledge-any')
    .description('Pledge capacity to any project on your watchlist')
    .argument('<max-tasks>', 'Number of tasks to complete')
    .option('--max-complexity <c>', 'Max issue complexity: trivial | small | medium | large', 'large')
    .action(async (maxTasksStr: string, opts: { maxComplexity: string }) => {
      const config = loadConfig();
      requireAuth(config);
      const api = new TahApiClient(config.coordinatorUrl, config.authToken);

      const maxTasks = parseInt(maxTasksStr, 10);
      if (isNaN(maxTasks) || maxTasks < 1) {
        console.error('max-tasks must be a positive integer');
        process.exit(1);
      }

      const pledge = await api.post<GenericPledge>('/contributors/me/generic-pledges', {
        maxTasks,
        maxComplexity: opts.maxComplexity,
      });

      console.log(`Generic pledge created: ${pledge.maxTasks} task(s) (up to ${pledge.maxComplexity}) from any watched project.`);
    });

  return cmd;
}
