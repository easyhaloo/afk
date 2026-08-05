import { describe, expect, it } from 'vitest';
import { COMMANDS } from './command-registry';

describe('CLI hard cutover registry', () => {
  it('registers only canonical backlog execution entrypoints', () => {
    const names = COMMANDS.flatMap(entry => entry.names);
    expect(names).toContain('backlog');
    expect(names).toContain('run');
    expect(names).toContain('loop');
    expect(names).toContain('qa');
    expect(names).not.toContain('tracker');
    expect(names).not.toContain('issue');
    expect(names).not.toContain('mr');
    expect(names).not.toContain('workflow');
    expect(names).not.toContain('escalate');
    expect(names).not.toContain('worktree');
  });
});
