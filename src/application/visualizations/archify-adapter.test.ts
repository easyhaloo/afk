import { describe, expect, it } from 'vitest';
import { buildArchifyCommands, runArchifyAdapter } from './archify-adapter';

describe('Archify adapter', () => {
  it('constructs only the fixed validation and delivery commands', () => {
    const commands = buildArchifyCommands('/tmp/input.json', '/tmp/output.html', '/opt/archify');
    expect(commands.validate.args).toEqual(['validate', 'workflow', '/tmp/input.json', '--quality', 'showcase', '--json']);
    expect(commands.deliver.args).toEqual(['deliver', 'workflow', '/tmp/input.json', '/tmp/output.html', '--quality', 'showcase', '--json']);
  });

  it('reports optional runtime failures without failing graph generation', async () => {
    const calls: string[][] = [];
    const result = await runArchifyAdapter('/tmp/input.json', '/tmp/output.html', { run: async (command) => { calls.push([...command.args]); return { stdout: 'v2.15.0' }; } });
    expect(result).toMatchObject({ available: true, validated: true, delivered: true });
    expect(calls).toHaveLength(2);
  });

  it('rejects non-absolute paths', () => {
    expect(() => buildArchifyCommands('input.json', '/tmp/output.html')).toThrow();
  });
});
