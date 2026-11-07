import { Command } from 'commander';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PluginRuntime, type PluginManager } from '@afk/runtime/plugin-sdk';
import { registerPluginCommands } from './plugin.js';

describe('plugin commands', () => {
  it('validates invoke input and returns a failing status for a failed capability result', async () => {
    const runtime = new PluginRuntime();
    const verify = vi.fn(async () => ({ passed: false, durationMs: 1, output: 'test failed' }));
    await runtime.activate({
      manifest: { id: 'verification.fixture', version: '1.0.0', apiVersion: 1, provides: ['verification.provider'], trusted: true },
      activate(context) { context.registerVerificationProvider('fixture', { id: 'fixture', capabilities: { 'static-analysis': false, 'test-execution': true, 'custom-script': false }, verify }); },
    });
    const directory = await mkdtemp(join(tmpdir(), 'plugin-invoke-'));
    const input = join(directory, 'input.json');
    await writeFile(input, '{"target":"/repo"}');
    const exitCode = process.exitCode;
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const program = new Command().exitOverride();
    registerPluginCommands(program, { pluginRuntime: runtime });
    try {
      await program.parseAsync(['node', 'afk', 'plugin', 'invoke', 'verification.provider', 'fixture', 'verify', '--input', input]);
      expect(verify).toHaveBeenCalledWith({ target: '/repo' });
      expect(process.exitCode).toBe(1);
      expect(JSON.parse(String(output.mock.calls[0][0]))).toEqual({ passed: false, durationMs: 1, output: 'test failed' });
      await expect(program.parseAsync(['node', 'afk', 'plugin', 'invoke', 'credential.provider', 'fixture', 'get', '--input', input])).rejects.toThrow('credential operations are private');
      await writeFile(input, '{"token":"SYNTHETIC_SECRET_VALUE" invalid}');
      await expect(program.parseAsync(['node', 'afk', 'plugin', 'configure', 'fixture', '--file', input])).rejects.toThrow('Plugin input file must contain valid JSON');
    } finally {
      process.exitCode = exitCode;
      output.mockRestore();
      await runtime.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('lists loaded plugins and registrations as JSON', async () => {
    const runtime = new PluginRuntime();
    await runtime.activate({
      manifest: { id: 'agent.test', version: '1.0.0', apiVersion: 1, provides: ['agent.provider'], trusted: true },
      activate(context) { context.registerCapability('agent.provider', 'test', {}); },
    });
    const output: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write;
    const program = new Command().name('afk').exitOverride();
    registerPluginCommands(program, { pluginRuntime: runtime });
    try { await program.parseAsync(['node', 'afk', 'plugin', 'list', '--json']); }
    finally { process.stdout.write = write; }
    expect(JSON.parse(output.join(''))).toEqual([{ id: 'agent.test', capabilities: ['agent.provider'], providers: ['test'] }]);
  });

  it('routes installation to the shared plugin manager', async () => {
    const install = vi.fn(async () => ({ id: 'context.example', version: '1.0.0' }));
    const manager = { install } as unknown as PluginManager;
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const program = new Command().name('afk').exitOverride();
    registerPluginCommands(program, { pluginRuntime: new PluginRuntime(), pluginManager: manager });
    try {
      await program.parseAsync(['node', 'afk', 'plugin', 'install', '/tmp/context-example']);
      expect(install).toHaveBeenCalledWith('/tmp/context-example');
      expect(output).toHaveBeenCalledWith('Installed context.example@1.0.0\n');
    } finally { output.mockRestore(); }
  });

  it('returns a failing exit status for missing plugins in JSON doctor output', async () => {
    const exitCode = process.exitCode;
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const program = new Command().name('afk').exitOverride();
    registerPluginCommands(program, { pluginRuntime: new PluginRuntime() });
    try {
      await program.parseAsync(['node', 'afk', 'plugin', 'doctor', '--plugin', 'host.missing', '--json']);
      expect(process.exitCode).toBe(1);
      expect(String(output.mock.calls[0][0])).toContain('plugin.not-found');
    } finally { process.exitCode = exitCode; output.mockRestore(); }
  });
});
