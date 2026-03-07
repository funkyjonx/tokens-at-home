import { Command } from 'commander';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { createInterface } from 'readline';
import { stdin as input, stdout as output } from 'process';
import { loadConfig, requireAuth } from '../config.js';
import { TahApiClient } from '../api.js';
import { mapGitHubLabelsToComplexity } from '@tah/shared';
import type { Project, Issue } from '@tah/shared';

async function syncProjectIssues(api: TahApiClient, project: Project, dryRun: boolean): Promise<void> {
  console.log(`Syncing "${project.issueLabel}" issues from ${project.githubOwner}/${project.githubRepo}...`);

  const SYNC_LIMIT = 500;
  const result = spawnSync(
    'gh',
    [
      'issue', 'list',
      '--repo', `${project.githubOwner}/${project.githubRepo}`,
      '--label', project.issueLabel,
      '--state', 'open',
      '--json', 'number,title,body,labels',
      '--limit', String(SYNC_LIMIT),
    ],
    { encoding: 'utf-8' },
  );

  if (result.status !== 0) {
    console.error(`gh issue list failed: ${result.stderr}`);
    return;
  }

  const ghIssues = JSON.parse(result.stdout) as Array<{
    number: number;
    title: string;
    body: string;
    labels: Array<{ name: string }>;
  }>;

  const openNumbers = new Set(ghIssues.map((i) => i.number));

  // Cancel coordinator issues that are no longer open on GitHub
  const coordinatorIssues = await api.get<Issue[]>(`/projects/${project.id}/issues`);
  const toCancel = coordinatorIssues.filter(
    (i) => i.status === 'available' && !openNumbers.has(i.githubNumber),
  );
  for (const issue of toCancel) {
    if (dryRun) {
      console.log(`  [dry-run] would cancel #${issue.githubNumber}: ${issue.title} (closed on GitHub)`);
      continue;
    }
    try {
      await api.patch(`/projects/${project.id}/issues/${issue.id}/cancel`, {});
      console.log(`  - #${issue.githubNumber}: ${issue.title} (cancelled — closed on GitHub)`);
    } catch { /* ignore */ }
  }

  if (ghIssues.length === 0) {
    console.log(`No open issues found with label "${project.issueLabel}".`);
    return;
  }

  console.log(`Found ${ghIssues.length} issue(s).${ghIssues.length === SYNC_LIMIT ? ` (hit limit of ${SYNC_LIMIT} — there may be more; run sync again after processing these)` : ''}\n`);

  let added = 0;
  let skipped = 0;
  let failed = 0;

  for (const ghIssue of ghIssues) {
    const labelNames = ghIssue.labels.map((l) => l.name);
    const complexity = mapGitHubLabelsToComplexity(labelNames) ?? 'small';

    if (dryRun) {
      console.log(`  [dry-run] #${ghIssue.number}: ${ghIssue.title} (${complexity})`);
      continue;
    }

    try {
      await api.post<Issue>(`/projects/${project.id}/issues`, {
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

  if (!dryRun) {
    console.log(`\nDone: ${added} added, ${skipped} already registered${failed ? `, ${failed} failed` : ''}.`);
  }
}

async function confirmProjectRegistration(owner: string, repo: string, languages: string[], skipConfirmation = false): Promise<boolean> {
  console.log('Project to register:');
  console.log(`  Owner:     ${owner}`);
  console.log(`  Repo:      ${repo}`);
  console.log(`  Languages: ${languages.join(', ')}`);

  if (skipConfirmation) {
    return true;
  }

  if (!input.isTTY || !output.isTTY) {
    console.error('Interactive confirmation required. Re-run with --yes to register non-interactively.');
    return false;
  }

  const rl = createInterface({ input, output });
  try {
    const answer = await new Promise<string>((resolve) => rl.question('\nSubmit? [y/N] ', resolve));
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

export function projectCommand(): Command {
  const cmd = new Command('project').description('Manage projects');

  cmd
    .command('register')
    .alias('add')
    .description('Register a GitHub repository as a project')
    .argument('<owner>', 'GitHub owner (user or org)')
    .argument('<repo>', 'GitHub repository name')
    .option('-l, --languages <langs>', 'Comma-separated languages (e.g. typescript,rust)', 'typescript')
    .option('--label <label>', 'GitHub label for eligible issues', 'tah')
    .option('--max-concurrent <n>', 'Max concurrent tasks', '3')
    .option('--trust-threshold <n>', 'Min contributor trust score (0–1) to receive tasks', '0')
    .option('--claude-md <file>', 'Path to a CLAUDE.md file to inject as project context for contributors')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (owner: string, repo: string, opts: {
      languages: string;
      label: string;
      maxConcurrent: string;
      trustThreshold: string;
      claudeMd?: string;
      yes?: boolean;
    }) => {
      const config = loadConfig();
      requireAuth(config);

      // Verify the authenticated gh user has push access to this repo
      const ghCheck = spawnSync(
        'gh',
        ['api', `repos/${owner}/${repo}`, '--jq', '.permissions.push'],
        { encoding: 'utf-8' },
      );
      if (ghCheck.status !== 0) {
        console.error(`Could not verify repo access: ${ghCheck.stderr.trim() || 'gh api failed'}`);
        console.error('Make sure you are authenticated with `gh auth login` and the repo exists.');
        process.exit(1);
      }
      const hasPush = ghCheck.stdout.trim() === 'true';
      if (!hasPush) {
        console.error(`You do not have push access to ${owner}/${repo}.`);
        console.error('Only maintainers with push access can register a project.');
        process.exit(1);
      }

      const api = new TahApiClient(config.coordinatorUrl, config.authToken);

      const languages = opts.languages.split(',').map((l) => l.trim());

      let claudeMd: string | undefined;
      if (opts.claudeMd) {
        try {
          claudeMd = readFileSync(opts.claudeMd, 'utf-8');
        } catch {
          console.error(`Could not read CLAUDE.md file: ${opts.claudeMd}`);
          process.exit(1);
        }
        if (claudeMd.length > 4000) {
          console.error(`CLAUDE.md content exceeds 4000 character limit (${claudeMd.length} chars). Trim it before registering.`);
          process.exit(1);
        }
      }

      const confirmed = await confirmProjectRegistration(owner, repo, languages, opts.yes === true);
      if (!confirmed) {
        console.log('Canceled. Project was not submitted.');
        return;
      }

      const project = await api.post<Project>('/projects', {
        githubOwner: owner,
        githubRepo: repo,
        languages,
        issueLabel: opts.label,
        taskTypes: ['code'],
        maxConcurrent: parseInt(opts.maxConcurrent, 10),
        trustThreshold: parseFloat(opts.trustThreshold),
        ...(claudeMd ? { claudeMd } : {}),
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

      for (let i = 0; i < projects.length; i++) {
        const p = projects[i];
        const name = `${p.githubOwner}/${p.githubRepo}`;
        const id = `[${p.id}]`;
        console.log(`${name.padEnd(48)} ${id}`);
        console.log(`  Languages:  ${p.languages.join(', ')}`);
        console.log(`  Tasks:      ${p.taskTypes.join(', ')}`);
        const trustLabel = p.trustThreshold === 0 ? `${p.trustThreshold} (open to all)` : String(p.trustThreshold);
        console.log(`  Trust req:  ${trustLabel}`);
        if (i < projects.length - 1) console.log('');
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

      const issue = await api.post<Issue & { warning?: string }>(`/projects/${projectId}/issues`, payload);

      console.log(`Issue registered: ${issue.id}`);
      console.log(`  #${issue.githubNumber}: ${issue.title}`);
      console.log(`  Complexity: ${issue.estimatedComplexity} (~${issue.estimatedTokens.toLocaleString()} tokens)`);
      if (issue.warning) console.warn(`  Warning: ${issue.warning}`);
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
    .argument('[project-id]', 'Project ID (omit when using --all)')
    .option('--dry-run', 'Print what would be synced without registering anything')
    .option('--all', 'Sync all projects registered by you')
    .action(async (projectId: string | undefined, opts: { dryRun?: boolean; all?: boolean }) => {
      const config = loadConfig();
      requireAuth(config);
      const api = new TahApiClient(config.coordinatorUrl, config.authToken);

      if (opts.all) {
        if (!config.githubUsername) {
          console.error('GitHub username not found in config. Run `tah contributor register` first.');
          process.exit(1);
        }
        const allProjects = await api.get<Project[]>('/projects');
        const mine = allProjects.filter((p) => p.registeredBy === config.githubUsername);
        if (mine.length === 0) {
          console.log('No projects registered by you.');
          return;
        }
        for (let i = 0; i < mine.length; i++) {
          if (i > 0) console.log('');
          await syncProjectIssues(api, mine[i], opts.dryRun ?? false);
        }
      } else {
        if (!projectId) {
          console.error('Provide a project ID or use --all to sync all your projects.');
          process.exit(1);
        }
        const project = await api.get<Project>(`/projects/${projectId}`);
        await syncProjectIssues(api, project, opts.dryRun ?? false);
      }
    });

  cmd.addCommand(issueCmd);

  cmd
    .command('search')
    .description('Search for projects by name')
    .argument('<query>', 'Search term (matches owner or repo name)')
    .option('--language <lang>', 'Filter by language')
    .action(async (query: string, opts: { language?: string }) => {
      const config = loadConfig();
      const api = new TahApiClient(config.coordinatorUrl);

      const params = new URLSearchParams({ q: query });
      if (opts.language) params.set('language', opts.language);
      const projects = await api.get<Project[]>(`/projects?${params}`);

      if (projects.length === 0) {
        console.log('No projects found.');
        return;
      }

      for (const p of projects) {
        const name = `${p.githubOwner}/${p.githubRepo}`;
        console.log(`${name.padEnd(48)} [${p.id}]`);
        console.log(`  Languages: ${p.languages.join(', ')}`);
      }
    });

  cmd
    .command('pin <ownerRepo>')
    .description('Pin a project — worker will prioritize its issues')
    .action(async (ownerRepo: string) => {
      const [owner, repo] = ownerRepo.split('/');
      if (!owner || !repo) { console.error('Format: tah project pin owner/repo'); process.exit(1); }
      const config = loadConfig();
      requireAuth(config);
      const api = new TahApiClient(config.coordinatorUrl, config.authToken);
      const project = await api.findProjectByRepo(owner, repo);
      if (!project) { console.error(`Project ${ownerRepo} not found. Register it with: tah project add ${ownerRepo}`); process.exit(1); }
      await api.pinProject(project.id);
      console.log(`Pinned ${ownerRepo}. Worker will prioritize this project's issues.`);
    });

  cmd
    .command('unpin <ownerRepo>')
    .description('Remove a project pin')
    .action(async (ownerRepo: string) => {
      const [owner, repo] = ownerRepo.split('/');
      if (!owner || !repo) { console.error('Format: tah project unpin owner/repo'); process.exit(1); }
      const config = loadConfig();
      requireAuth(config);
      const api = new TahApiClient(config.coordinatorUrl, config.authToken);
      const project = await api.findProjectByRepo(owner, repo);
      if (!project) { console.error(`Project ${ownerRepo} not found.`); process.exit(1); }
      await api.unpinProject(project.id);
      console.log(`Unpinned ${ownerRepo}.`);
    });

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
