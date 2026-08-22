import { describe, it, expect } from 'vitest';
import { buildCompletionTree } from '../../cli/completion/tree';
import { extractSpec } from './spec';

describe('extractSpec', () => {
  const spec = extractSpec(buildCompletionTree());

  it('includes the backlog command with its management subcommands', () => {
    const backlog = spec.commands.find(c => c.name === 'backlog');
    expect(backlog).toBeDefined();
    expect(backlog!.subcommands.map(c => c.name).sort()).toEqual(['create', 'init', 'list', 'show', 'tag']);
  });

  it('captures required backlog ID and options on run', () => {
    const run = spec.commands.find(c => c.name === 'run')!;
    expect(run.options.map(o => o.long)).toContain('--backlog-id');
  });

  it('excludes commander auto-generated help subcommands', () => {
    for (const c of spec.commands) {
      expect(c.name).not.toBe('help');
      for (const s of c.subcommands) {
        expect(s.name).not.toBe('help');
      }
    }
  });
});
