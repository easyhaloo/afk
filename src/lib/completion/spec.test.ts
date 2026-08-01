import { describe, it, expect } from 'vitest';
import { buildCompletionTree } from './tree';
import { extractSpec } from './spec';

describe('extractSpec', () => {
  const spec = extractSpec(buildCompletionTree());

  it('includes the issue command with its subcommands', () => {
    const issue = spec.commands.find(c => c.name === 'issue');
    expect(issue).toBeDefined();
    const subNames = issue!.subcommands.map(c => c.name).sort();
    expect(subNames).toEqual(['comment', 'create', 'edit', 'get', 'link', 'list', 'update-labels']);
  });

  it('captures positional arguments and option flags on issue get', () => {
    const issue = spec.commands.find(c => c.name === 'issue')!;
    const get = issue.subcommands.find(c => c.name === 'get')!;
    expect(get.args.map(a => a.name)).toEqual(['id']);
    expect(get.args[0].required).toBe(true);
    expect(get.options.map(o => o.long)).toContain('--json');
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
