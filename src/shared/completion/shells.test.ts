import { describe, it, expect } from 'vitest';
import { buildCompletionTree } from '../../cli/completion/tree';
import { extractSpec } from './spec';
import { emitZsh } from './shells';

const script = emitZsh(extractSpec(buildCompletionTree()));

describe('emitZsh', () => {
  it('produces a #compdef afk script wired with compdef', () => {
    expect(script).toContain('#compdef afk');
    expect(script).toContain('compdef _afk afk');
  });

  it('inlines top-level command names with descriptions', () => {
    expect(script).toContain("'backlog:");
    expect(script).toContain("'signal:");
    expect(script).toContain("'run:");
    expect(script).toContain("'loop:");
  });

  it('does not suggest the excluded board command', () => {
    expect(script).not.toMatch(/'board:/);
  });

  it('inlines option flags', () => {
    expect(script).toContain('--backlog-id');
  });

  it('pre-wires the __complete dynamic hook', () => {
    expect(script).toContain('afk __complete');
  });
});
