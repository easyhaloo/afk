import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { registerHostCommands } from './host.js';

function runtime(connection: object) {
  return { getHostProvider: vi.fn(() => connection) } as never;
}

describe('host commands', () => {
  it('lists provider hosts as JSON', async () => {
    const program = new Command().name('afk').exitOverride();
    registerHostCommands(program, {
      pluginRuntime: runtime({ listHosts: async () => [{ id: '1', alias: 'web-1', provider: 'ssh', address: '10.0.0.1' }] }),
    });
    const output: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      await program.parseAsync(['node', 'afk', 'host', 'ls', '--json']);
    } finally {
      process.stdout.write = write;
    }
    expect(JSON.parse(output.join(''))).toEqual([{ id: '1', alias: 'web-1', provider: 'ssh', address: '10.0.0.1' }]);
  });

  it('forwards the remote argv and timeout without joining arguments', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: 'ok\n', stderr: '' }));
    const program = new Command().name('afk').exitOverride();
    registerHostCommands(program, {
      pluginRuntime: runtime({
        listHosts: async () => [],
        exec,
      }),
    });
    await program.parseAsync(['node', 'afk', 'host', 'exec', 'web-1', '--timeout', '15s', '--', 'printf', 'a b']);
    expect(exec).toHaveBeenCalledWith('web-1', ['printf', 'a b'], { timeoutMs: 15_000 });
  });
});
