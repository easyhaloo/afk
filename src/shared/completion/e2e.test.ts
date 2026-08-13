import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';

const run = (args: string) =>
  execSync(`node_modules/.bin/tsx src/index.ts ${args}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

describe('completion end-to-end via dispatcher', () => {
  it('afk completion zsh prints the zsh script', () => {
    expect(run('completion zsh')).toContain('#compdef afk');
  });

  it('afk completion bash prints the bash script', () => {
    expect(run('completion bash')).toContain('complete -F _afk afk');
  });

  it('afk __complete returns empty (no candidates yet)', () => {
    expect(run('__complete issue get')).toBe('');
  });
});
