import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { contributors, issues, projects, tasks, projectPins } from '../db/schema.js';
import type { Issue, Project, Contributor } from '@tah/shared';
import { COMPLEXITY_ORDER } from '@tah/shared';

const TERMINAL_STATUSES = ['completed', 'failed'];

export function scoreMatch(
  contributor: Contributor,
  issue: Issue,
  project: Project,
  isPinned: boolean,
): number | null {
  // Complexity cap: reject issues above contributor's maxComplexity
  if (COMPLEXITY_ORDER[issue.estimatedComplexity] > COMPLEXITY_ORDER[contributor.maxComplexity]) return null;

  // Language overlap (0-1): fraction of project languages the contributor speaks
  const contributorLangs = new Set(contributor.languages.map((l) => l.toLowerCase()));
  const projectLangs = project.languages.map((l) => l.toLowerCase());
  const overlap = projectLangs.filter((l) => contributorLangs.has(l)).length;
  const langScore = projectLangs.length > 0 ? overlap / projectLangs.length : 0.5;

  // Hard filter: if the project declares languages and the contributor speaks none of them, skip
  if (projectLangs.length > 0 && overlap === 0) return null;

  // Prefer more complex issues (more meaningful work)
  const complexityScore = COMPLEXITY_ORDER[issue.estimatedComplexity] / 4;

  // Pinned project bonus
  const pinBonus = isPinned ? 0.3 : 0;

  return langScore * 0.5 + complexityScore * 0.2 + pinBonus;
}

export async function findMatchForContributor(
  db: Db,
  contributorId: string,
): Promise<{ issueId: string; score: number } | null> {
  const contributor = await db
    .select()
    .from(contributors)
    .where(eq(contributors.id, contributorId))
    .get();

  if (!contributor || !contributor.available) return null;

  // Check concurrency limit
  const activeTasks = await db
    .select({ status: tasks.status })
    .from(tasks)
    .where(eq(tasks.contributorId, contributorId))
    .all();
  const activeCount = activeTasks.filter((t) => !TERMINAL_STATUSES.includes(t.status)).length;
  if (activeCount >= contributor.maxConcurrent) return null;

  // Load available issues
  const availableIssues = await db
    .select()
    .from(issues)
    .where(eq(issues.status, 'available'))
    .all();

  if (availableIssues.length === 0) return null;

  const allProjects = await db.select().from(projects).all();
  const projectMap = new Map(allProjects.map((p) => [p.id, p]));

  // Load pins for this contributor
  const pins = await db
    .select({ projectId: projectPins.projectId })
    .from(projectPins)
    .where(eq(projectPins.contributorId, contributorId))
    .all();
  const pinnedProjectIds = new Set(pins.map((p) => p.projectId));

  const contributorTyped: Contributor = {
    ...contributor,
    languages: JSON.parse(contributor.languages) as string[],
    maxComplexity: contributor.maxComplexity as Contributor['maxComplexity'],
    available: Boolean(contributor.available),
  };

  const candidates: Array<{ issueId: string; score: number }> = [];

  for (const issue of availableIssues) {
    const project = projectMap.get(issue.projectId);
    if (!project) continue;

    const projectTyped = {
      ...project,
      languages: JSON.parse(project.languages) as string[],
      taskTypes: JSON.parse(project.taskTypes) as string[],
    } as unknown as Project;

    const isPinned = pinnedProjectIds.has(project.id);
    const score = scoreMatch(contributorTyped, issue as unknown as Issue, projectTyped, isPinned);
    if (score !== null) {
      candidates.push({ issueId: issue.id, score });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]!;
}
