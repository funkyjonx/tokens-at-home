import { Command } from 'commander';
import { spawnSync } from 'child_process';
import { loadConfig, requireAuth } from '../config.js';
import { TahApiClient } from '../api.js';
import { mapGitHubLabelsToComplexity } from '@tah/shared';
import type { Project, Issue } from '@tah/shared';

export function projectCommand(): Command {
  const cmd = new Command('project').description('Manage projects');

  cmd
    .command('register')
    .description('Register a GitHub repository as a project')
    .argument('<owner>', 'GitHub owner (user or org)')
    .argument('<repo>', 'GitHub repository name')
    .option('-l, --languages <langs>', 'Comma-separated languages (e.g. typescript,rust)', 'typescript')
    .option('--label <label>', 'GitHub label for eligible issues', 'tah')
    .option('--max-concurrent <n>', 'Max concurrent tasks', '3')
    .action(async (owner: string, repo: string, opts: {
      languages: string;
      label: string;
      maxConcurrent: string;
    }) => {
      const config = loadConfig();
      requireAuth(config);
      const api = new TahApiClient(config.coordinatorUrl, config.authToken);

      const languages = opts.languages.split(',').map((l) => l.trim());
      const project = await api.post<Project>('/projects', {
        githubOwner: owner,
        githubRepo: repo,
        languages,
        issueLabel: opts.label,
        taskTypes: ['code'],
        maxConcurrent: parseInt(opts.maxConcurrent, 10),
        trustThreshold: 0,
      });

      console.log(`Project registered: ${project.id}`);
      console.log(`  ${owner}/${repo}`);
      console.log(`  Label: ${project.issueLabel}`);
      console.log(`  Languages: ${project.languages.join(', ')}`);
    });

  cmd
    .command('list')
    .description('List all registered projects')
    .action(async () => {
      const config = loadConfig();
      const api = new TahApiClient(config.coordinatorUrl);
      const projects = await api.get<Project[]>('/projects');

      if (projects.length === 0) {
        console.log('No projects registered.');
        return;
      }

      for (const p of projects) {
        console.log(`[${p.id}] ${p.githubOwner}/${p.githubRepo} (label: ${p.issueLabel})`);
      }
    });

  // 'tah project issue add | list | sync'
  const issueCmd = new Command('issue').description('Manage project issues');

  issueCmd
    .command('add')
    .description('Register an issue as available for contributors')
    .argument('<project-id>', 'Project ID')
    .argument('<issue-number>', 'GitHub issue number')
    .argument('[title]', 'Issue title (fetched from GitHub if omitted)')
    .option('--complexity <c>', 'trivial | small | medium | large (inferred from GitHub labels if omitted)')
    .option('--type <t>', 'code | tests | docs | deps | review', 'code')
    .option('--body <body>', 'Issue body text (fetched from GitHub if omitted)')
    .action(async (projectId: string, issueNumber: string, title: string | undefined, opts: {
      complexity?: string;
      type: string;
      body?: string;
    }) => {
      const config = loadConfig();
      requireAuth(config);
      const api = new TahApiClient(config.coordinatorUrl, config.authToken);

      const payload: Record<string, unknown> = {
        githubNumber: parseInt(issueNumber, 10),
        taskType: opts.type,
      };
      if (title) payload['title'] = title;
      if (opts.body) payload['body'] = opts.body;
      if (opts.complexity) payload['estimatedComplexity'] = opts.complexity;

      const issue = await api.post<Issue>(`/projects/${projectId}/issues`, payload);

      console.log(`Issue registered: ${issue.id}`);
      console.log(`  #${issue.githubNumber}: ${issue.title}`);
      console.log(`  Complexity: ${issue.estimatedComplexity} (~${issue.estimatedTokens.toLocaleString()} tokens)`);
    });

  issueCmd
    .command('list')
    .description('List issues for a project')
    .argument('<project-id>', 'Project ID')
    .action(async (projectId: string) => {
      const config = loadConfig();
      const api = new TahApiClient(config.coordinatorUrl);
      const issues = await api.get<Issue[]>(`/projects/${projectId}/issues`);

      if (issues.length === 0) {
        console.log('No issues.');
        return;
      }

      for (const i of issues) {
        console.log(`[${i.id}] #${i.githubNumber} ${i.title} — ${i.status} (${i.estimatedComplexity})`);
      }
    });

  issueCmd
    .command('sync')
    .description('Sync all open labeled issues from GitHub into the coordinator')
    .argument('<project-id>', 'Project ID')
    .option('--dry-run', 'Print what would be synced without registering anything')
    .action(async (projectId: string, opts: { dryRun?: boolean }) => {
      const config = loadConfig();
      requireAuth(config);
      const api = new TahApiClient(config.coordinatorUrl, config.authToken);

      const project = await api.get<Project>(`/projects/${projectId}`);
      console.log(`Syncing "${project.issueLabel}" issues from ${project.githubOwner}/${project.githubRepo}...`);

      const result = spawnSync(
        'gh',
        [
          'issue', 'list',
          '--repo', `${project.githubOwner}/${project.githubRepo}`,
          '--label', project.issueLabel,
          '--state', 'open',
          '--json', 'number,title,body,labels',
          '--limit', '100',
        ],
        { encoding: 'utf-8' },
      );

      if (result.status !== 0) {
        console.error(`gh issue list failed: ${result.stderr}`);
        process.exit(1);
      }

      const ghIssues = JSON.parse(result.stdout) as Array<{
        number: number;
        title: string;
        body: string;
        labels: Array<{ name: string }>;
      }>;

      if (ghIssues.length === 0) {
        console.log(`No open issues found with label "${project.issueLabel}".`);
        return;
      }

      console.log(`Found ${ghIssues.length} issue(s).\n`);

      let added = 0;
      let skipped = 0;
      let failed = 0;

      for (const ghIssue of ghIssues) {
        const labelNames = ghIssue.labels.map((l) => l.name);
        const complexity = mapGitHubLabelsToComplexity(labelNames) ?? 'small';

        if (opts.dryRun) {
          console.log(`  [dry-run] #${ghIssue.number}: ${ghIssue.title} (${complexity})`);
          continue;
        }

        try {
          await api.post<Issue>(`/projects/${projectId}/issues`, {
            githubNumber: ghIssue.number,
            title: ghIssue.title,
            body: ghIssue.body ?? '',
            taskType: 'code',
            estimatedComplexity: complexity,
          });
          console.log(`  + #${ghIssue.number}: ${ghIssue.title} (${complexity})`);
          added++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('(409)')) {
            console.log(`  ~ #${ghIssue.number}: ${ghIssue.title} (already registered)`);
            skipped++;
          } else {
            console.error(`  ✗ #${ghIssue.number}: ${ghIssue.title} — ${msg}`);
            failed++;
          }
        }
      }

      if (!opts.dryRun) {
        console.log(`\nDone: ${added} added, ${skipped} already registered${failed ? `, ${failed} failed` : ''}.`);
      }
    });

  cmd.addCommand(issueCmd);

  // Shorthand alias
  cmd
    .command('issues')
    .description('List issues for a project (alias for "issue list")')
    .argument('<project-id>', 'Project ID')
    .action(async (projectId: string) => {
      const config = loadConfig();
      const api = new TahApiClient(config.coordinatorUrl);
      const issues = await api.get<Issue[]>(`/projects/${projectId}/issues`);

      if (issues.length === 0) {
        console.log('No issues.');
        return;
      }

      for (const i of issues) {
        console.log(`[${i.id}] #${i.githubNumber} ${i.title} — ${i.status} (${i.estimatedComplexity})`);
      }
    });

  return cmd;
}
