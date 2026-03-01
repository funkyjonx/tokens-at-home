import { Command } from 'commander';
import { loadConfig, saveConfig } from '../config.js';

const SETTABLE_KEYS = ['coordinatorUrl'] as const;
type SettableKey = (typeof SETTABLE_KEYS)[number];

export function configCommand(): Command {
  const cmd = new Command('config').description('Get or set tah configuration');

  cmd
    .argument('<key>', `Config key: ${SETTABLE_KEYS.join(' | ')}`)
    .argument('<value>', 'Value to set')
    .action((key: string, value: string) => {
      if (!SETTABLE_KEYS.includes(key as SettableKey)) {
        console.error(`Unknown config key: ${key}`);
        console.error(`Valid keys: ${SETTABLE_KEYS.join(', ')}`);
        process.exit(1);
      }
      const config = loadConfig();
      saveConfig({ ...config, [key]: value });
      console.log(`Set ${key} = ${value}`);
    });

  return cmd;
}
