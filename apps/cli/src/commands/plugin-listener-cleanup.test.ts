import { Command } from 'commander';
import { afterEach, expect, it, vi } from 'vitest';
import { registerPluginCommands } from './plugin.js';

const listener = vi.hoisted(() => ({ dispose: vi.fn(), close: vi.fn() }));
vi.mock('@afk/runtime/plugin-sdk', async original => ({
  ...await original<typeof import('@afk/runtime/plugin-sdk')>(),
  createDefaultPluginRuntime: vi.fn(async () => ({ diagnostics: async () => [], dispose: listener.dispose })),
  startPluginListener: vi.fn(async () => {
    queueMicrotask(() => process.emit('SIGTERM'));
    return { address: { address: '127.0.0.1', port: 8374 }, close: listener.close };
  }),
}));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('disposes trigger runtime even when durable queue shutdown rejects', async () => {
  vi.stubEnv('TEST_LISTENER_TOKEN', 'synthetic-listener-token');
  listener.close.mockRejectedValueOnce(new Error('queue storage failed'));
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const counts = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  const program = new Command().exitOverride();
  registerPluginCommands(program);
  await expect(program.parseAsync(['node', 'afk', 'plugin', 'listen', '--token-env', 'TEST_LISTENER_TOKEN'])).rejects.toThrow('queue storage failed');
  expect(listener.dispose).toHaveBeenCalledOnce();
  expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(counts);
});

it('surfaces plugin runtime warnings on stderr while starting the listener', async () => {
  vi.stubEnv('TEST_LISTENER_TOKEN', 'synthetic-listener-token');
  const { createDefaultPluginRuntime } = await import('@afk/runtime/plugin-sdk');
  vi.mocked(createDefaultPluginRuntime).mockImplementationOnce(async options => {
    options?.warn?.('optional provider could not be loaded');
    return { diagnostics: async () => [], dispose: listener.dispose } as never;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const program = new Command().exitOverride();
  registerPluginCommands(program);
  await program.parseAsync(['node', 'afk', 'plugin', 'listen', '--token-env', 'TEST_LISTENER_TOKEN']);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('optional provider could not be loaded'));
  expect(listener.dispose).toHaveBeenCalledOnce();
});
