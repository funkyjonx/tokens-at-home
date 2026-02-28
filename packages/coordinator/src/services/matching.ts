import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { contributors, issues, pledges, projects, tasks } from '../db/schema.js';
import type { Issue, Project, Contributor, Pledge } from '@tah/shared';
import { COMPLEXITY_TOKEN_ESTIMATES } from '@tah/shared';

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

  // Budget check: rough token estimate must fit within pledge
  // For MVP we treat budgetPercent as the fraction of a 100k token budget
  const estimatedAvailable = (pledge.budgetPercent / 100) * 100_000;
  if (issue.estimatedTokens > estimatedAvailable) return null;

  // Task type check
  if (!project.taskTypes.includes(issue.taskType)) return null;

  // Language overlap score (0-1)
  const contributorLangs = new Set(contributor.languages.map((l) => l.toLowerCase()));
  const projectLangs = project.languages.map((l) => l.toLowerCase());
  const overlap = projectLangs.filter((l) => contributorLangs.has(l)).length;
  const langScore = projectLangs.length > 0 ? overlap / projectLangs.length : 0.5;

  // Complexity fit: prefer issues at the top of contributor budget without wasting it
  const complexityTokens = COMPLEXITY_TOKEN_ESTIMATES[issue.estimatedComplexity];
  const budgetUtilization = complexityTokens / estimatedAvailable;
  // Peak score around 0.5-0.8 utilization
  const utilizationScore = budgetUtilization <= 1
    ? 1 - Math.abs(budgetUtilization - 0.65)
    : 0;

  // Trust bonus (0-0.2): reward higher-trust contributors
  const trustBonus = contributor.trustScore * 0.2;

  return langScore * 0.5 + utilizationScore * 0.3 + trustBonus;
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

  // Count active tasks per contributor
  const activeTasks = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.status, 'dispatched'),
      ),
    )
    .all();

  const activeTaskCount = new Map<string, number>();
  for (const t of activeTasks) {
    activeTaskCount.set(t.contributorId, (activeTaskCount.get(t.contributorId) ?? 0) + 1);
  }

  const candidates: Array<{ contributorId: string; issueId: string; pledgeId: string; score: number }> = [];

  for (const contributor of availableContributors) {
    const currentTasks = activeTaskCount.get(contributor.id) ?? 0;
    if (currentTasks >= contributor.maxConcurrent) continue;

    // Find pledges for this contributor
    const contributorPledges = activePledges.filter((p) => p.contributorId === contributor.id);

    for (const pledge of contributorPledges) {
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
