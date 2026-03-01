#!/usr/bin/env node
import { Command } from 'commander';
import { projectCommand } from './commands/project.js';
import { contributorCommand } from './commands/contributor.js';
import { daemonCommand } from './commands/daemon.js';
import { taskCommand } from './commands/task.js';
import { configCommand } from './commands/config.js';

const program = new Command();

program
  .name('tah')
  .description('Tokens at Home - contribute your unused Claude capacity to open source')
  .version('0.0.1');

program.addCommand(configCommand());
program.addCommand(projectCommand());
program.addCommand(contributorCommand());
program.addCommand(daemonCommand());
program.addCommand(taskCommand());

program.parse(process.argv);
