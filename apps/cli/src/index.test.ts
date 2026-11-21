import { PluginRuntime } from '@afk/runtime/plugin-sdk';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createRuntime: vi.fn(), dispatch: vi.fn() }));
vi.mock('./composition-root.js', () => ({ createCliPluginRuntime: mocks.createRuntime }));
vi.mock('./command-registry.js', () => ({ dispatchCommand: mocks.dispatch }));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
let runtime: PluginRuntime;
let dispose: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  runtime = new PluginRuntime();
  dispose = vi.spyOn(runtime, 'dispose');
  mocks.createRuntime.mockReset().mockResolvedValue(runtime);
  mocks.dispatch.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

const start = async (...args: string[]) => {
  process.argv = ['node', 'afk', ...args];
  await import('./index.js');
};

it.each([
  ['plugin', 'configure'], ['plugin', 'install'], ['plugin', 'enable'], ['plugin', 'disable'], ['plugin', 'remove'],
  ['observe', 'timeline'], ['completion'], ['--help'],
  ['run', '--help'], ['execute', '--help'], ['reconcile', '--help'], ['qa', '-h'], ['loop', '--help'], ['schedule', '--help'], ['graph', '--help'],
])('dispatches %s %s without activating unrelated providers', async (...args) => {
  await start(...args);
  await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledOnce());
  expect(mocks.dispatch).toHaveBeenCalledWith(args[0], args.slice(1), expect.any(Object));
  expect(mocks.createRuntime).not.toHaveBeenCalled();
  expect(dispose).not.toHaveBeenCalled();
});

it.each(['run', 'execute', 'reconcile', 'qa', 'loop', 'schedule', 'graph'])('retains the shared execution runtime for %s and disposes it after dispatch', async command => {
  mocks.dispatch.mockImplementation(async (_command, _args, context) => {
    expect(context.pluginRuntime).toBe(runtime);
    expect(dispose).not.toHaveBeenCalled();
  });
  await start(command);
  await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  expect(mocks.createRuntime).toHaveBeenCalledOnce();
  expect(console.error).not.toHaveBeenCalled();
});

it('shares a runtime only when requested and disposes it after command completion', async () => {
  mocks.dispatch.mockImplementation(async (_command, _args, context: { createRuntime: () => Promise<PluginRuntime> }) => {
    const [first, second] = await Promise.all([context.createRuntime(), context.createRuntime()]);
    expect(first).toBe(runtime);
    expect(second).toBe(runtime);
    expect(dispose).not.toHaveBeenCalled();
  });
  await start('plugin', 'list');
  await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  expect(mocks.createRuntime).toHaveBeenCalledOnce();
  expect(console.error).not.toHaveBeenCalled();
});

it('disposes an activated runtime when the dispatched command fails', async () => {
  mocks.dispatch.mockImplementation(async (_command, _args, context: { createRuntime: () => Promise<PluginRuntime> }) => {
    await context.createRuntime();
    throw new Error('fixture command failed');
  });
  await start('plugin', 'invoke');
  await vi.waitFor(() => expect(process.exitCode).toBe(1));
  expect(dispose).toHaveBeenCalledOnce();
  expect(console.error).toHaveBeenCalledOnce();
  expect(console.error).toHaveBeenCalledWith('fixture command failed');
});

it('reports runtime construction failure once without attempting disposal', async () => {
  mocks.createRuntime.mockRejectedValue(new Error('fixture activation failed'));
  mocks.dispatch.mockImplementation(async (_command, _args, context: { createRuntime: () => Promise<PluginRuntime> }) => context.createRuntime());
  await start('host', 'ls');
  await vi.waitFor(() => expect(process.exitCode).toBe(1));
  expect(mocks.dispatch).toHaveBeenCalledOnce();
  expect(mocks.createRuntime).toHaveBeenCalledOnce();
  expect(dispose).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledOnce();
  expect(console.error).toHaveBeenCalledWith('fixture activation failed');
});

it.each([new Error('PRIVATE_TRANSCRIPT credential=PRIVATE_TOKEN'), 'PRIVATE_TOKEN'])('sanitizes an owned runtime disposal rejection', async failure => {
  dispose.mockRejectedValue(failure);
  mocks.dispatch.mockImplementation(async (_command, _args, context: { createRuntime: () => Promise<PluginRuntime> }) => context.createRuntime());
  await start('experience', 'validate');
  await vi.waitFor(() => expect(process.exitCode).toBe(1));
  expect(dispose).toHaveBeenCalledOnce();
  expect(console.error).toHaveBeenCalledOnce();
  expect(console.error).toHaveBeenCalledWith('Plugin runtime cleanup failed');
});
