import { Command } from 'commander';
import { loadConfig, requireAuth } from '../config.js';
import { TahApiClient } from '../api.js';
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

  cmd
    .command('issue add')
    .description('Register an issue as available for contributors')
    .argument('<project-id>', 'Project ID')
    .argument('<issue-number>', 'GitHub issue number')
    .argument('<title>', 'Issue title')
    .option('--complexity <c>', 'trivial | small | medium | large', 'small')
    .option('--type <t>', 'code | tests | docs | deps | review', 'code')
    .option('--body <body>', 'Issue body text', '')
    .action(async (projectId: string, issueNumber: string, title: string, opts: {
      complexity: string;
      type: string;
      body: string;
    }) => {
      const config = loadConfig();
      requireAuth(config);
      const api = new TahApiClient(config.coordinatorUrl, config.authToken);

      const issue = await api.post<Issue>(`/projects/${projectId}/issues`, {
        githubNumber: parseInt(issueNumber, 10),
        title,
        body: opts.body,
        taskType: opts.type,
        estimatedComplexity: opts.complexity,
      });

      console.log(`Issue registered: ${issue.id}`);
      console.log(`  #${issue.githubNumber}: ${issue.title}`);
      console.log(`  Complexity: ${issue.estimatedComplexity} (~${issue.estimatedTokens.toLocaleString()} tokens)`);
    });

  cmd
    .command('issues')
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

  return cmd;
}
