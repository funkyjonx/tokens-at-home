import { Command } from 'commander';
import { loadConfig, saveConfig } from '../config.js';

const SETTABLE_KEYS = ['coordinatorUrl'] as const;
type SettableKey = (typeof SETTABLE_KEYS)[number];

const MASKED_TOKEN_PLACEHOLDER = '***';

export function maskAuthToken(token?: string): string {
  if (!token) return '(not set)';
  if (token.length <= 8) return `${token.slice(0, 1)}${MASKED_TOKEN_PLACEHOLDER}`;
  return `${token.slice(0, 3)}${MASKED_TOKEN_PLACEHOLDER}...${token.slice(-4)}`;
}

function showConfig(): void {
  const config = loadConfig();

  console.log(`coordinatorUrl: ${config.coordinatorUrl}`);
  console.log(`contributorId:  ${config.contributorId ?? '(not set)'}`);
  console.log(`authToken:      ${maskAuthToken(config.authToken)}`);
}

function setConfigValue(key: string, value: string): void {
  if (!SETTABLE_KEYS.includes(key as SettableKey)) {
    console.error(`Unknown config key: ${key}`);
    console.error(`Valid keys: ${SETTABLE_KEYS.join(', ')}`);
    process.exit(1);
  }
  const config = loadConfig();
  saveConfig({ ...config, [key]: value });
  console.log(`Set ${key} = ${value}`);
}

export function configCommand(): Command {
  const cmd = new Command('config').description('Get or set tah configuration');

  cmd
    .command('show')
    .description('Display current configuration (auth token is masked)')
    .action(showConfig);

  cmd
    .argument('[key]', `Config key: ${SETTABLE_KEYS.join(' | ')}`)
    .argument('[value]', 'Value to set')
    .action((key?: string, value?: string) => {
      if (!key && !value) {
        showConfig();
        return;
      }
      if (!key || !value) {
        console.error('Usage: tah config [key] [value] or tah config show');
        process.exit(1);
      }

      setConfigValue(key, value);
    });

  return cmd;
}
