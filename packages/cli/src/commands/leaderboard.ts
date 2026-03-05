import { Command } from 'commander';
import { loadConfig } from '../config.js';
import { TahApiClient } from '../api.js';
import type { LeaderboardEntry, LeaderboardPeriod, LeaderboardSort } from '@tah/shared';

export function leaderboardCommand(): Command {
  const cmd = new Command('leaderboard')
    .description('Show top contributors on the platform')
    .option('--period <p>', 'Time period: all | month | week', 'all')
    .option('--sort <s>', 'Sort by: tokens | tasks | streak', 'tokens')
    .option('--limit <n>', 'Number of entries to show', '10')
    .action(async (opts: { period: string; sort: string; limit: string }) => {
      const config = loadConfig();
      const api = new TahApiClient(config.coordinatorUrl);

      const period = opts.period as LeaderboardPeriod;
      const sort = opts.sort as LeaderboardSort;
      const limit = parseInt(opts.limit, 10) || 10;

      const entries = await api.get<LeaderboardEntry[]>(
        `/leaderboard?period=${period}&sort=${sort}&limit=${limit}`,
      );

      if (entries.length === 0) {
        console.log('No data yet.');
        return;
      }

      const header = `${'#'.padEnd(4)}${'Contributor'.padEnd(24)}${'Tasks'.padEnd(8)}${'Tokens'.padEnd(14)}${'Success'.padEnd(10)}Streak`;
      console.log(header);
      console.log('-'.repeat(header.length));

      for (const e of entries) {
        const rank = String(e.rank).padEnd(4);
        const name = e.githubUsername.padEnd(24);
        const tasks = String(e.tasksCompleted).padEnd(8);
        const tokens = e.totalTokensDonated.toLocaleString('en-US').padEnd(14);
        const success = `${Math.round(e.successRate * 100)}%`.padEnd(10);
        const streak = e.currentStreak > 0 ? `${e.currentStreak}d` : '—';
        console.log(`${rank}${name}${tasks}${tokens}${success}${streak}`);
      }
    });

  return cmd;
}
