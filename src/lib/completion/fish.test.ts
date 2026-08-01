import { describe, it, expect } from 'vitest';
import { buildCompletionTree } from './tree';
import { extractSpec } from './spec';
import { emitFish } from './shells';

const script = emitFish(extractSpec(buildCompletionTree()));

describe('emitFish', () => {
  it('uses complete -c afk declarations', () => {
    expect(script).toContain('complete -c afk');
  });

  it('inlines top-level commands gated on __fish_use_subcommand', () => {
    expect(script).toMatch(/complete -c afk -n '__fish_use_subcommand' -a 'issue'/);
    expect(script).toMatch(/complete -c afk -n '__fish_use_subcommand' -a 'signal'/);
  });

  it('excludes board from top-level candidates', () => {
    expect(script).not.toMatch(/-n '__fish_use_subcommand' -a 'board'/);
  });

  it('gates subcommands on __fish_seen_subcommand_from', () => {
    expect(script).toMatch(/__fish_seen_subcommand_from issue/);
  });

  it('inlines option flags as -l long', () => {
    expect(script).toContain('-l json');
  });

  it('pre-wires the __complete dynamic hook', () => {
    expect(script).toContain('afk __complete');
  });
});
