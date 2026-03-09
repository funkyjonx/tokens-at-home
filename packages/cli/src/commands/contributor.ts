import { Command } from 'commander';
import { createInterface } from 'readline';
import { loadConfig, saveConfig, requireAuth, DEFAULT_COORDINATOR_URL } from '../config.js';
import { TahApiClient } from '../api.js';
import { getGithubUsername } from '../utils.js';
import type { Contributor, PublicContributor, IssueComplexity } from '@tah/shared';

export function contributorCommand(): Command {
  const cmd = new Command('contributor').description('Manage contributor profile');

  cmd
    .command('register')
    .description('Register as a contributor (run once before tah start)')
    .option('--coordinator <url>', 'Coordinator URL', DEFAULT_COORDINATOR_URL)
    .action(async (opts: { coordinator: string }) => {
      const config = loadConfig();
      if (config.authToken && config.contributorId) {
        console.log(`Already registered as @${config.githubUsername}. Run 'tah contributor update' to change your profile.`);
        return;
      }

      const coordinatorUrl = opts.coordinator ?? config.coordinatorUrl;
      console.log('\n  Tokens at Home — donate your Claude capacity to open source\n');

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const p = (q: string) => new Promise<string>((resolve) => rl.question(q, (a) => resolve(a.trim())));

      let username: string | undefined;
      const detected = getGithubUsername();
      if (detected) {
        const confirm = await p(`  Register as ${detected}? [Y/n]: `);
        username = confirm.toLowerCase() === 'n' ? (await p('  GitHub username: ')) : detected;
      } else {
        username = await p('  GitHub username: ');
      }

      if (!username) {
        console.error('Username required');
        rl.close();
        process.exit(1);
      }

      const langsRaw = await p('  Languages (comma-separated, e.g. typescript,python) [typescript]: ');
      const languages = langsRaw
        ? langsRaw.split(',').map((l) => l.trim().toLowerCase()).filter(Boolean)
        : ['typescript'];

      const maxConcurrentStr = await p('  Max concurrent tasks [1]: ');
      const maxConcurrent = parseInt(maxConcurrentStr || '1', 10) || 1;

      const validComplexities = ['trivial', 'small', 'medium', 'large'];
      let maxComplexity: IssueComplexity = 'medium';
      while (true) {
        const raw = await p('  Max complexity (trivial/small/medium/large) [medium]: ');
        if (!raw) break;
        if (validComplexities.includes(raw)) { maxComplexity = raw as IssueComplexity; break; }
        console.log('  Invalid. Choose: trivial, small, medium, large');
      }

      const budgetRaw = await p('  Task budget (number of tasks before pausing, leave blank for unlimited): ');
      const taskBudget = budgetRaw ? (parseInt(budgetRaw, 10) || undefined) : undefined;

      rl.close();

      const api = new TahApiClient(coordinatorUrl);
      let result: { contributor: Contributor; token: string };
      try {
        result = await api.post<{ contributor: Contributor; token: string }>('/contributors', {
          githubUsername: username,
          languages,
          maxConcurrent,
          maxComplexity,
          ...(taskBudget !== undefined ? { taskBudget } : {}),
        });

        saveConfig({
          ...config,
          coordinatorUrl,
          contributorId: result.contributor.id,
          authToken: result.token,
          githubUsername: result.contributor.githubUsername,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('(409)')) {
          console.error(`\n  Username "${username}" is already registered.\n  If this is you, your config may be missing.`);
        } else {
          console.error(`\n  Registration failed: ${msg}`);
        }
        process.exit(1);
      }

      console.log(`\n  Registered as @${username}!`);
      if (taskBudget === undefined) {
        console.log(`  No budget set — the worker will run until you stop it.`);
        console.log(`  Tip: run 'tah contributor budget add <n>' to set a task limit.\n`);
      } else {
        console.log(`  Budget: ${taskBudget} task${taskBudget === 1 ? '' : 's'}.\n`);
      }
      console.log(`  Run 'tah start' to begin contributing.\n`);
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
    .command('update')
    .description('Update your contributor profile (languages, concurrency, complexity)')
    .action(async () => {
      const config = loadConfig();
      requireAuth(config);
      const api = new TahApiClient(config.coordinatorUrl, config.authToken);

      const current = await api.get<Contributor>('/contributors/me');
      console.log(`\n  Current profile for @${current.githubUsername}:`);
      console.log(`  Languages:   ${current.languages.join(', ')}`);
      console.log(`  Concurrent:  ${current.maxConcurrent}`);
      console.log(`  Complexity:  ${current.maxComplexity}`);
      console.log('');

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const p = (q: string) => new Promise<string>((resolve) => rl.question(q, (a) => resolve(a.trim())));

      const langsRaw = await p(`  Languages [${current.languages.join(',')}]: `);
      const languages = langsRaw
        ? langsRaw.split(',').map((l) => l.trim().toLowerCase()).filter(Boolean)
        : undefined;

      const concurrentRaw = await p(`  Max concurrent [${current.maxConcurrent}]: `);
      const maxConcurrent = concurrentRaw ? (parseInt(concurrentRaw, 10) || undefined) : undefined;

      const validComplexities = ['trivial', 'small', 'medium', 'large'];
      let maxComplexity: string | undefined;
      while (true) {
        const raw = await p(`  Max complexity [${current.maxComplexity}]: `);
        if (!raw) break;
        if (validComplexities.includes(raw)) { maxComplexity = raw; break; }
        console.log('  Invalid. Choose: trivial, small, medium, large');
      }

      rl.close();

      const updates: Record<string, unknown> = {};
      if (languages) updates['languages'] = languages;
      if (maxConcurrent) updates['maxConcurrent'] = maxConcurrent;
      if (maxComplexity) updates['maxComplexity'] = maxComplexity;

      if (Object.keys(updates).length === 0) {
        console.log('\n  No changes made.');
        return;
      }

      await api.patch('/contributors/me', updates);
      console.log('\n  Profile updated.');
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
