import { describe, it, expect } from 'vitest';
import { buildSandboxConfig, formatAllowedTools } from './sandbox.js';
import { join } from 'path';

describe('buildSandboxConfig', () => {
  it('creates paths under the work directory', () => {
    const config = buildSandboxConfig('task123', 'code', '/work', '/logs');
    expect(config.taskWorkDir).toBe(join('/work', 'task123'));
    expect(config.logFile).toBe(join('/logs', 'task123.log'));
  });

  it('uses code tools for code task type', () => {
    const config = buildSandboxConfig('t1', 'code', '/w', '/l');
    expect(config.allowedTools).toContain('Bash(git *)');
    expect(config.allowedTools).toContain('Read');
    expect(config.allowedTools).toContain('Edit');
  });

  it('uses docs tools for docs task type', () => {
    const config = buildSandboxConfig('t2', 'docs', '/w', '/l');
    expect(config.allowedTools).not.toContain('Bash(npm *)');
  });

  it('isolates different tasks in separate directories', () => {
    const c1 = buildSandboxConfig('task-A', 'code', '/work', '/logs');
    const c2 = buildSandboxConfig('task-B', 'code', '/work', '/logs');
    expect(c1.taskWorkDir).not.toBe(c2.taskWorkDir);
  });
});

describe('formatAllowedTools', () => {
  it('joins tools with commas', () => {
    const result = formatAllowedTools(['Read', 'Edit', 'Bash(git *)']);
    expect(result).toBe('Read,Edit,Bash(git *)');
  });

  it('handles single tool', () => {
    expect(formatAllowedTools(['Read'])).toBe('Read');
  });

  it('handles empty array', () => {
    expect(formatAllowedTools([])).toBe('');
  });
});
