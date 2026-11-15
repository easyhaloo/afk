import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecFileException } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { runVerificationCommand } from '../../infrastructure/verification/command.js';
import { PluginManager } from './manager.js';
import { assertToolTarget } from './tool-recipes.js';

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), execFile: launch }));
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); launch.mockReset(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

function childFixture() {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
  let callback!: (error: ExecFileException | null, stdout: string, stderr: string) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  launch.mockImplementation((_file, _args, _options, done) => { callback = done; started(); return child; });
  return { child, ready, finish: (error: ExecFileException | null) => callback(error, 'output', '') };
}

it('keeps verification cancellation pending until actual child close', async () => {
  const f = childFixture(), stop = new AbortController(), reason = new Error('owned cancellation');
  let settled = false;
  const result = runVerificationCommand([process.execPath, 'owned-fixture'], { cwd: tmpdir(), timeoutMs: 1000, signal: stop.signal }).catch(error => error).finally(() => { settled = true; });
  await f.ready;
  stop.abort(reason);
  expect(f.child.kill).toHaveBeenCalledWith('SIGKILL');
  f.finish(Object.assign(new Error('abort callback'), { code: 'ABORT_ERR' }));
  await Promise.resolve(); await Promise.resolve();
  expect(settled).toBe(false);
  f.child.emit('close', null, 'SIGKILL');
  expect(await result).toBe(reason);
});

it('keeps normal verification results pending until child close', async () => {
  const f = childFixture();
  let settled = false;
  const result = runVerificationCommand([process.execPath, 'owned-fixture'], { cwd: tmpdir(), timeoutMs: 1000 }).finally(() => { settled = true; });
  f.finish(null);
  await Promise.resolve(); await Promise.resolve();
  expect(settled).toBe(false);
  f.child.emit('close', 0, null);
  expect(await result).toEqual({ exitCode: 0, stdout: 'output', stderr: '' });
});

it.each([256, 3221225477, -1073741510])('preserves platform exit code %s in a closed native observation', async code => {
  const f = childFixture();
  const result = runVerificationCommand([process.execPath, 'owned-fixture'], { cwd: tmpdir(), timeoutMs: 1000, executionId: 'platform-exit' });
  f.finish(Object.assign(new Error('platform exit'), { code }));
  f.child.emit('close', code, null);
  expect(await result).toMatchObject({ exitCode: code, execution: { executionId: 'platform-exit', exitCode: code, closed: true } });
});

it.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')('retains the npm stage and lock after cancellation callback until process close', async () => {
  const f = childFixture(), stop = new AbortController();
  const root = await fs.mkdtemp(join(tmpdir(), 'afk-managed-tool-process-')); roots.push(root);
  const manager = new PluginManager({ homeDir: root });
  let settled = false;
  const result = manager.installTool('browser-check-1.62.1', { target: 'host-local', signal: stop.signal }).catch(error => error).finally(() => { settled = true; });
  await f.ready;
  stop.abort(new Error('npm cancellation')); f.finish(Object.assign(new Error('abort callback'), { code: 'ABORT_ERR' }));
  await Promise.resolve(); await Promise.resolve();
  expect(settled).toBe(false);
  const directory = join(root, '.afk', 'plugins');
  expect((await fs.readdir(directory)).some(name => name.startsWith('.install-'))).toBe(true);
  expect((await fs.stat(join(directory, '.manager.lock'))).isFile()).toBe(true);
  const npmOptions = launch.mock.calls[0][2];
  expect(npmOptions.env).toMatchObject({ npm_config_ignore_scripts: 'true', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', npm_config_globalconfig: '/dev/null' });
  expect(npmOptions.env.HOME).toContain('.install-');
  f.child.emit('close', null, 'SIGKILL');
  expect(await result).toMatchObject({ message: 'npm cancellation' });
  expect(await fs.readdir(directory)).toEqual([]);
});

it.each([['linux', 'arm64'], ['darwin', 'x64']])('rejects unsupported host %s/%s before staging', (platform, architecture) => {
  const beforePlatform = Object.getOwnPropertyDescriptor(process, 'platform')!, beforeArch = Object.getOwnPropertyDescriptor(process, 'arch')!;
  try {
    Object.defineProperty(process, 'platform', { value: platform }); Object.defineProperty(process, 'arch', { value: architecture });
    expect(() => assertToolTarget('browser-check-1.62.1', { target: 'host-local' })).toThrow('platform/architecture');
  } finally { Object.defineProperty(process, 'platform', beforePlatform); Object.defineProperty(process, 'arch', beforeArch); }
});

it.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')('rejects capacity exhaustion before npm and without changing configuration', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'afk-managed-tool-capacity-')); roots.push(root);
  vi.spyOn(fs, 'statfs').mockResolvedValueOnce({ bavail: 0, bsize: 4096 } as Awaited<ReturnType<typeof fs.statfs>>);
  const manager = new PluginManager({ homeDir: root });
  await expect(manager.installTool('browser-check-1.62.1', { target: 'host-local' })).rejects.toThrow('capacity');
  expect(launch).not.toHaveBeenCalled();
  await expect(fs.stat(join(root, '.afk', 'plugins.yml'))).rejects.toMatchObject({ code: 'ENOENT' });
});
