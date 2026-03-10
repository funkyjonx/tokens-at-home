import { Command } from 'commander';
import { projectCommand } from './commands/project.js';
import { contributorCommand } from './commands/contributor.js';
import { workerCommand } from './commands/worker.js';
import { taskCommand } from './commands/task.js';
import { configCommand } from './commands/config.js';
import { activityCommand } from './commands/activity.js';
import { leaderboardCommand } from './commands/leaderboard.js';
import { startCommand } from './commands/start.js';
import { statsCommand } from './commands/stats.js';
import { TahApiError } from './api.js';
import { loadConfig } from './config.js';

const program = new Command();

program
  .name('tah')
  .description('Tokens at Home - contribute your unused Claude capacity to open source')
  .version('0.0.1');

program.addCommand(startCommand());
program.addCommand(configCommand());
program.addCommand(projectCommand());
program.addCommand(contributorCommand());
program.addCommand(workerCommand());
program.addCommand(taskCommand());
program.addCommand(activityCommand());
program.addCommand(leaderboardCommand());
program.addCommand(statsCommand());

function handleError(err: unknown): never {
  if (err instanceof TahApiError) {
    if (err.status === 401) {
      console.error('Authentication failed. Re-run `tah contributor register`.');
    } else if (err.status === 404) {
      console.error('Resource not found. Check the ID and try again.');
    } else {
      console.error(err.message);
    }
  } else if (err instanceof Error) {
    const msg = err.message;
    if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED')) {
      const config = loadConfig();
      console.error(`Could not reach coordinator at ${config.coordinatorUrl}. Is it running?`);
    } else {
      console.error(msg);
    }
  } else {
    console.error(String(err));
  }
  process.exit(1);
}

program.parseAsync(process.argv).catch(handleError);
