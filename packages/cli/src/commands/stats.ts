import { Command } from 'commander';
import { TahApiClient } from '../api.js';
import { loadConfig } from '../config.js';
import type { ContributorStats } from '@tah/shared';

function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

export function statsCommand(): Command {
  return new Command('stats')
    .description('Show contribution stats')
    .argument('[username]', 'GitHub username (defaults to your own)')
    .action(async (username?: string) => {
      const config = loadConfig();
      const api = new TahApiClient(config.coordinatorUrl, config.authToken);

      const target = username ?? config.githubUsername;
      if (!target) {
        console.error('Username not found in config. Run tah start first.');
        process.exit(1);
      }

      const stats = await api.get<ContributorStats>(`/contributors/${encodeURIComponent(target)}/stats`);

      const since = stats.memberSince.substring(0, 10);
      const rankStr = (r: number) => r > 0 ? `Rank #${r}` : 'Unranked';

      console.log(`\n  ${target} — contributing since ${since}\n`);
      console.log(`  ${'All time'.padEnd(20)}  This month`);
      console.log(`  ${'─'.repeat(19)}  ${'─'.repeat(19)}`);
      console.log(`  ${fmtNum(stats.allTime.tasksCompleted).padEnd(5)} tasks            ${fmtNum(stats.thisMonth.tasksCompleted)} tasks`);
      console.log(`  ${fmtNum(stats.allTime.tokensDonated).padEnd(12)} tokens  ${fmtNum(stats.thisMonth.tokensDonated)} tokens`);
      console.log(`  ${(Math.round(stats.allTime.successRate * 100) + '% success').padEnd(20)}  ${rankStr(stats.thisMonth.rank)}`);
      console.log(`  ${rankStr(stats.allTime.rank)}`);
      if (stats.topProjects.length > 0) {
        const top = stats.topProjects.map((p) => `${p.githubOwner}/${p.githubRepo} (${p.tasksCompleted})`).join('  ·  ');
        console.log(`\n  Top projects: ${top}`);
      }
      if (stats.bestStreak > 0) {
        console.log(`  Best streak: ${stats.bestStreak}d  ·  Current: ${stats.currentStreak}d`);
      }
      console.log();
    });
}
