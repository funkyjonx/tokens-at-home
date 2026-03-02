import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { contributors, issues, pledges, projects, tasks } from '../db/schema.js';
import type { Issue, Project, Contributor, Pledge } from '@tah/shared';

const TERMINAL_STATUSES = ['completed', 'failed'];
import { COMPLEXITY_ORDER } from '@tah/shared';

// Score a (contributor, issue) pair for matching
// Higher = better match. Returns null if the pair is ineligible.
export function scoreMatch(
  contributor: Contributor,
  issue: Issue,
  project: Project,
  pledge: Pledge,
): number | null {
  // Trust check
  if (contributor.trustScore < project.trustThreshold) return null;

  // Complexity cap: reject issues above the contributor's stated max complexity
  if (COMPLEXITY_ORDER[issue.estimatedComplexity] > COMPLEXITY_ORDER[pledge.maxComplexity]) return null;

  // Task type check
  if (!project.taskTypes.includes(issue.taskType)) return null;

  // Language overlap score (0-1)
  const contributorLangs = new Set(contributor.languages.map((l) => l.toLowerCase()));
  const projectLangs = project.languages.map((l) => l.toLowerCase());
  const overlap = projectLangs.filter((l) => contributorLangs.has(l)).length;
  const langScore = projectLangs.length > 0 ? overlap / projectLangs.length : 0.5;

  // Complexity preference (0-1): prefer larger issues within the cap
  // (more meaningful work > trivial busywork)
  const complexityScore = COMPLEXITY_ORDER[issue.estimatedComplexity] / 4;

  // Trust bonus (0-0.2): reward higher-trust contributors
  const trustBonus = contributor.trustScore * 0.2;

  return langScore * 0.5 + complexityScore * 0.3 + trustBonus;
}

// Find the best (contributor, issue) pairs for auto-matching.
// Returns ranked assignments to make.
export async function findBestMatches(
  db: Db,
  limit = 10,
): Promise<Array<{ contributorId: string; issueId: string; pledgeId: string; score: number }>> {
  // Load available contributors (available flag, under maxConcurrent)
  const availableContributors = await db
    .select()
    .from(contributors)
    .where(eq(contributors.available, true))
    .all();

  if (availableContributors.length === 0) return [];

  // Load available issues
  const availableIssues = await db
    .select()
    .from(issues)
    .where(eq(issues.status, 'available'))
    .all();

  if (availableIssues.length === 0) return [];

  // Load all active pledges
  const activePledges = await db
    .select()
    .from(pledges)
    .where(eq(pledges.active, true))
    .all();

  // Load all projects
  const allProjects = await db.select().from(projects).all();
  const projectMap = new Map(allProjects.map((p) => [p.id, p]));

  // Count tasks per contributor (for maxConcurrent) and per pledge (for maxTasks)
  const allTasks = await db
    .select({ contributorId: tasks.contributorId, pledgeId: tasks.pledgeId, status: tasks.status })
    .from(tasks)
    .all();

  const activeTaskCount = new Map<string, number>();
  const taskCountByPledge = new Map<string, number>();
  for (const t of allTasks) {
    if (!TERMINAL_STATUSES.includes(t.status)) {
      activeTaskCount.set(t.contributorId, (activeTaskCount.get(t.contributorId) ?? 0) + 1);
    }
    if (t.pledgeId) {
      taskCountByPledge.set(t.pledgeId, (taskCountByPledge.get(t.pledgeId) ?? 0) + 1);
    }
  }

  const candidates: Array<{ contributorId: string; issueId: string; pledgeId: string; score: number }> = [];

  for (const contributor of availableContributors) {
    const currentTasks = activeTaskCount.get(contributor.id) ?? 0;
    if (currentTasks >= contributor.maxConcurrent) continue;

    // Find pledges for this contributor
    const contributorPledges = activePledges.filter((p) => p.contributorId === contributor.id);

    for (const pledge of contributorPledges) {
      // Skip exhausted pledges
      if ((taskCountByPledge.get(pledge.id) ?? 0) >= pledge.maxTasks) continue;
      const project = projectMap.get(pledge.projectId);
      if (!project) continue;

      // Filter issues for this project
      const projectIssues = availableIssues.filter((i) => i.projectId === project.id);

      for (const issue of projectIssues) {
        // Map DB rows to shared types for scoring
        const { cycleResetDate: rawCycleReset, ...contributorRest } = contributor;
        const contributorTyped: Contributor = {
          ...contributorRest,
          languages: JSON.parse(contributor.languages) as string[],
          autonomy: contributor.autonomy as 'full' | 'review_before_pr',
          available: Boolean(contributor.available),
          ...(rawCycleReset != null ? { cycleResetDate: rawCycleReset } : {}),
        };
        const projectTyped = {
          ...project,
          languages: JSON.parse(project.languages) as string[],
          taskTypes: JSON.parse(project.taskTypes) as string[],
        } as unknown as Project;
        const pledgeTyped = {
          ...pledge,
          active: Boolean(pledge.active),
        };
        const issueTyped = issue as unknown as Issue;

        const score = scoreMatch(contributorTyped, issueTyped, projectTyped, pledgeTyped);
        if (score !== null) {
          candidates.push({ contributorId: contributor.id, issueId: issue.id, pledgeId: pledge.id, score });
        }
      }
    }
  }

  // Sort by score descending, deduplicate (each contributor/issue used once)
  candidates.sort((a, b) => b.score - a.score);

  const usedContributors = new Set<string>();
  const usedIssues = new Set<string>();
  const results: typeof candidates = [];

  for (const candidate of candidates) {
    if (results.length >= limit) break;
    if (usedContributors.has(candidate.contributorId)) continue;
    if (usedIssues.has(candidate.issueId)) continue;
    usedContributors.add(candidate.contributorId);
    usedIssues.add(candidate.issueId);
    results.push(candidate);
  }

  return results;
}

// Find the best available issue for a single contributor.
// Called on every poll — returns the top-scored match or null.
export async function findMatchForContributor(
  db: Db,
  contributorId: string,
): Promise<{ issueId: string; pledgeId: string; score: number } | null> {
  const contributor = await db
    .select()
    .from(contributors)
    .where(eq(contributors.id, contributorId))
    .get();

  if (!contributor || !contributor.available) return null;

  // Count in-flight tasks (non-terminal)
  const allTasks = await db
    .select({ status: tasks.status })
    .from(tasks)
    .where(eq(tasks.contributorId, contributorId))
    .all();
  const activeCount = allTasks.filter((t) => !TERMINAL_STATUSES.includes(t.status)).length;
  if (activeCount >= contributor.maxConcurrent) return null;

  // Load active pledges for this contributor
  const contributorPledges = await db
    .select()
    .from(pledges)
    .where(and(eq(pledges.contributorId, contributorId), eq(pledges.active, true)))
    .all();
  if (contributorPledges.length === 0) return null;

  // Count tasks per pledge (active + completed) to check against maxTasks
  const pledgeTasks = await db
    .select({ pledgeId: tasks.pledgeId, status: tasks.status })
    .from(tasks)
    .where(eq(tasks.contributorId, contributorId))
    .all();
  const taskCountByPledge = new Map<string, number>();
  for (const t of pledgeTasks) {
    if (t.pledgeId) {
      taskCountByPledge.set(t.pledgeId, (taskCountByPledge.get(t.pledgeId) ?? 0) + 1);
    }
  }

  // Build typed contributor once
  const { cycleResetDate: rawCycleReset, ...contributorRest } = contributor;
  const contributorTyped: Contributor = {
    ...contributorRest,
    languages: JSON.parse(contributor.languages) as string[],
    autonomy: contributor.autonomy as 'full' | 'review_before_pr',
    ...(rawCycleReset != null ? { cycleResetDate: rawCycleReset } : {}),
  };

  const candidates: Array<{ issueId: string; pledgeId: string; score: number }> = [];

  for (const pledge of contributorPledges) {
    // Skip exhausted pledges
    const tasksForPledge = taskCountByPledge.get(pledge.id) ?? 0;
    if (tasksForPledge >= pledge.maxTasks) continue;
    const project = await db
      .select()
      .from(projects)
      .where(eq(projects.id, pledge.projectId))
      .get();
    if (!project) continue;

    const projectIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.projectId, project.id), eq(issues.status, 'available')))
      .all();

    const projectTyped = {
      ...project,
      languages: JSON.parse(project.languages) as string[],
      taskTypes: JSON.parse(project.taskTypes) as string[],
    } as unknown as Project;
    const pledgeTyped = { ...pledge, active: Boolean(pledge.active) };

    for (const issue of projectIssues) {
      const score = scoreMatch(contributorTyped, issue as unknown as Issue, projectTyped, pledgeTyped);
      if (score !== null) {
        candidates.push({ issueId: issue.id, pledgeId: pledge.id, score });
      }
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]!;
}
