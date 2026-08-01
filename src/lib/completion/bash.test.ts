import { describe, it, expect } from 'vitest';
import { buildCompletionTree } from './tree';
import { extractSpec } from './spec';
import { emitBash } from './shells';

const script = emitBash(extractSpec(buildCompletionTree()));

describe('emitBash', () => {
  it('registers a complete -F _afk afk binding', () => {
    expect(script).toContain('complete -F _afk afk');
  });

  it('inlines top-level commands in _afk_sub_TOP', () => {
    const m = script.match(/_afk_sub_TOP="([^"]*)"/);
    expect(m).toBeDefined();
    const words = m![1].split(/\s+/);
    expect(words).toContain('issue');
    expect(words).toContain('signal');
    expect(words).toContain('mr');
    expect(words).not.toContain('board');
  });

  it('inlines option flags', () => {
    expect(script).toContain('--json');
  });

  it('pre-wires the __complete dynamic hook', () => {
    expect(script).toContain('afk __complete');
  });
});
