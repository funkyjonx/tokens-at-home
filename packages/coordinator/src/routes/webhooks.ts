import { Hono } from 'hono';
import { createHmac, timingSafeEqual, randomBytes } from 'crypto';
import { eq, and, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { projects, issues } from '../db/schema.js';
import { fetchRepoLanguages, fetchTahConfig } from '../services/github.js';

export function webhookRoutes(db: Db, secret: string) {
  const app = new Hono();

  app.post('/', async (c) => {
    const rawBody = await c.req.text();

    // Verify HMAC-SHA256 signature
    if (!verifySignature(rawBody, c.req.header('X-Hub-Signature-256') ?? '', secret)) {
      return c.json({ error: 'Invalid signature' }, 401);
    }

    const event = c.req.header('X-GitHub-Event') ?? '';
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    switch (event) {
      case 'ping':
        return c.json({ ok: true });
      case 'installation':
        await handleInstallation(db, payload);
        return c.json({ ok: true });
      case 'installation_repositories':
        await handleInstallationRepositories(db, payload);
        return c.json({ ok: true });
      default:
        return c.json({ ok: true, event, note: 'unhandled' });
    }
  });

  return app;
}

function verifySignature(body: string, signature: string, secret: string): boolean {
  if (!signature.startsWith('sha256=')) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function handleInstallation(db: Db, payload: Record<string, unknown>) {
  const action = payload['action'] as string;
  const installation = payload['installation'] as { id: number; account: { login: string } };
  const installationId = String(installation.id);

  if (action === 'created') {
    const repos = (payload['repositories'] as Array<{ name: string; full_name: string }>) ?? [];
    await registerRepos(db, installationId, installation.account.login, repos);
  } else if (action === 'deleted') {
    await deactivateInstallation(db, installationId);
  }
}

async function handleInstallationRepositories(db: Db, payload: Record<string, unknown>) {
  const installation = payload['installation'] as { id: number; account: { login: string } };
  const installationId = String(installation.id);
  const action = payload['action'] as string;

  if (action === 'added') {
    const repos = (payload['repositories_added'] as Array<{ name: string; full_name: string }>) ?? [];
    await registerRepos(db, installationId, installation.account.login, repos);
  } else if (action === 'removed') {
    const repos = (payload['repositories_removed'] as Array<{ name: string; full_name: string }>) ?? [];
    for (const repo of repos) {
      await deactivateRepo(db, installation.account.login, repo.name);
    }
  }
}

async function registerRepos(
  db: Db,
  installationId: string,
  owner: string,
  repos: Array<{ name: string; full_name: string }>,
) {
  for (const repo of repos) {
    const existing = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.githubOwner, owner), eq(projects.githubRepo, repo.name)))
      .get();
    if (existing) continue;

    const [languages, config] = await Promise.all([
      fetchRepoLanguages(owner, repo.name),
      fetchTahConfig(owner, repo.name),
    ]);

    await db.insert(projects).values({
      id: randomBytes(8).toString('hex'),
      githubOwner: owner,
      githubRepo: repo.name,
      registeredBy: 'github-app',
      languages: JSON.stringify(languages),
      issueLabel: config.label,
      taskTypes: JSON.stringify(config.taskTypes),
      maxConcurrent: config.maxConcurrent,
      trustThreshold: 0,
      githubInstallationId: installationId,
    });
  }
}

async function deactivateInstallation(db: Db, installationId: string) {
  const affectedProjects = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.githubInstallationId, installationId))
    .all();

  for (const project of affectedProjects) {
    await deactivateProjectIssues(db, project.id);
  }
}

async function deactivateRepo(db: Db, owner: string, repo: string) {
  const project = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.githubOwner, owner), eq(projects.githubRepo, repo)))
    .get();
  if (project) await deactivateProjectIssues(db, project.id);
}

async function deactivateProjectIssues(db: Db, projectId: string) {
  const now = new Date().toISOString();
  await db
    .update(issues)
    .set({ status: 'cancelled', updatedAt: now })
    .where(and(eq(issues.projectId, projectId), inArray(issues.status, ['available'])));
}
