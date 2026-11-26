import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PluginManager, readInstalledPlugin } from './manager.js';
import { readPluginConfiguration } from './configuration.js';
import { createDefaultPluginRuntime } from './default-runtime.js';
import { invokeCapability } from './operations.js';
import { BrowserCheckVerificationProvider } from '../../infrastructure/verification/index.js';
import { LifecycleDispatcher } from '../workflows/lifecycle.js';
import { PluginRuntime } from './runtime.js';
import { createManagedPlaywrightPlugin } from './managed-playwright.js';
import { TOOL_ASSETS } from './tool-recipes.js';
import { simpleGit } from 'simple-git';
import { randomUUID } from 'node:crypto';
import { createPluginRunObserver } from './observability.js';

async function observedWorkspace(runtime: PluginRuntime, worktreePath: string, root: string) {
  await simpleGit(worktreePath).init().addConfig('user.name', 'Tool verification test')
    .addConfig('user.email', 'tools@example.test').commit('Tool verification revision', { '--allow-empty': null });
  const observer = createPluginRunObserver(runtime, join(root, 'events'));
  const identity = { traceId: randomUUID(), runId: randomUUID(), workItemId: 'github:acme/api#42',
    profileId: 'test', attempt: 1, actor: { kind: 'system' as const, id: 'tool-verification' } };
  return { iid: 42, baseBranch: 'main', sessionName: 'managed-tool', worktreePath, params: {},
    observation: { context: identity, record: observer.record.bind(observer, identity) } };
}

const roots: string[] = [];
it('uses provider-neutral managed recipe package names', async () => {
  const metadata = JSON.parse(await fs.readFile(join(TOOL_ASSETS, 'package.json'), 'utf8'));
  const lock = JSON.parse(await fs.readFile(join(TOOL_ASSETS, 'npm-lock.json'), 'utf8'));
  expect([metadata.name, lock.name, lock.packages[''].name]).toEqual(['managed-playwright', 'managed-playwright', 'managed-playwright']);
});

afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

type ToolManager = PluginManager & { installTool(recipe: string, options: { target: string; offline?: boolean; signal?: AbortSignal }): Promise<{ id: string; entry: string }> };

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'afk-managed-tool-'));
  roots.push(root);
  const homeDir = join(root, 'home'), workspaceRoot = join(root, 'workspace');
  await fs.mkdir(workspaceRoot);
  const runNpm = vi.fn(async (_args: readonly string[], cwd: string) => {
    const lock = JSON.parse(await fs.readFile(join(cwd, 'package-lock.json'), 'utf8'));
    for (const [path, entry] of Object.entries(lock.packages) as Array<[string, { name?: string; version: string; dependencies?: object; optionalDependencies?: object; os?: string[] }]>) {
      if (!path) continue;
      const directory = join(cwd, path);
      const name = path.slice('node_modules/'.length);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: entry.version, dependencies: entry.dependencies, optionalDependencies: entry.optionalDependencies, os: entry.os }));
      await fs.writeFile(join(directory, 'cli.js'), 'process.stdout.write("managed-fixture:" + process.argv[2]);');
      await fs.writeFile(join(directory, 'dependency.js'), 'exports.fixture = true;');
    }
    await fs.writeFile(join(cwd, 'node_modules', '.package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: Object.fromEntries(Object.entries(lock.packages).filter(([path]) => path)) }));
  });
  const manager = new PluginManager({ homeDir, runNpm }) as ToolManager;
  return { root, homeDir, workspaceRoot, manager, runNpm };
}

describe.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')('supported host-local recipe', () => {
it('installs the closed recipe through PluginManager and executes the selected contained CLI', async () => {
  const f = await fixture();
  const builtin = vi.spyOn(BrowserCheckVerificationProvider.prototype, 'verify').mockRejectedValue(new Error('default browser provider must not run'));
  const record = await f.manager.installTool('browser-check-1.62.1', { target: 'host-local', offline: true });
  expect(record.id).toBe('verification.playwright-managed');
  expect(f.runNpm).toHaveBeenCalledTimes(1);
  const args = f.runNpm.mock.calls[0][0];
  expect(args).toContain('--ignore-scripts'); expect(args).toContain('--offline'); expect(args).not.toContain('--global');
  const configuration = readPluginConfiguration(f.homeDir);
  expect(configuration.plugins[0]).toMatchObject({ id: record.id, builtin: false, config: { execution: 'host-local' } });
  configuration.integrations = { verifications: [{ provider: 'playwright-managed' }] };
  await fs.writeFile(join(f.homeDir, '.afk', 'plugins.yml'), JSON.stringify(configuration));
  const runtime = await createDefaultPluginRuntime({ homeDir: f.homeDir, workspaceRoot: f.workspaceRoot });
  try {
    expect(runtime.getVerificationProvider('playwright-managed'), JSON.stringify(await runtime.diagnostics())).toBeDefined();
    const result = await invokeCapability(runtime, { capability: 'verification.provider', provider: 'playwright-managed', operation: 'verify', input: { target: f.workspaceRoot } });
    expect(result).toMatchObject({ passed: true, output: 'managed-fixture:test' });
    const selected = vi.spyOn(runtime.getVerificationProvider('playwright-managed')!, 'verify');
    const lifecycle = new LifecycleDispatcher(runtime.getLifecycleModules());
    await lifecycle.run('before-publish', await observedWorkspace(runtime, f.workspaceRoot, f.root));
    expect(selected).toHaveBeenCalledOnce();
    expect(builtin).not.toHaveBeenCalled();
    await expect(f.manager.remove(record.id)).rejects.toThrow(/active|reference/);
    const provider = runtime.getVerificationProvider('playwright-managed')!;
    await expect(provider.verify({ target: f.workspaceRoot, command: ['arbitrary'] })).rejects.toThrow(/command|override/);
    await expect(provider.verify({ target: 'ssh://remote/workspace' })).rejects.toThrow(/local|target|workspace/);
    await expect(provider.verify({ target: f.root })).rejects.toThrow(/workspace|escapes/);
  } finally { await runtime.dispose(); }
  await expect(f.manager.remove(record.id)).rejects.toThrow(/references.*unknown|unknown.*references/);
});

it.each(['remote-container', 'ssh', 'unknown'])('rejects %s targets before invoking npm', async target => {
  const f = await fixture();
  await expect(f.manager.installTool('browser-check-1.62.1', { target })).rejects.toThrow(/local|target|recipe/);
  expect(f.runNpm).not.toHaveBeenCalled();
  expect(readPluginConfiguration(f.homeDir).plugins).toEqual([]);
});

it('preserves the previous installed module and settings on npm failure or cancellation', async () => {
  const f = await fixture();
  const previous = await f.manager.installTool('browser-check-1.62.1', { target: 'host-local', offline: true });
  const directory = join(f.homeDir, '.afk', 'plugins', previous.id);
  const before = await fs.readFile(join(directory, 'install.json'), 'utf8');
  const config = await fs.readFile(join(f.homeDir, '.afk', 'plugins.yml'), 'utf8');
  const initialRuntime = await createDefaultPluginRuntime({ homeDir: f.homeDir, workspaceRoot: f.workspaceRoot });
  await initialRuntime.dispose();
  f.runNpm.mockRejectedValueOnce(Object.assign(new Error('injected disk capacity failure'), { code: 'ENOSPC' }));
  await expect(f.manager.installTool('browser-check-1.62.1', { target: 'host-local', offline: true })).rejects.toThrow('capacity');
  const stop = new AbortController(); stop.abort(new Error('cancelled before installation'));
  await expect(f.manager.installTool('browser-check-1.62.1', { target: 'host-local', signal: stop.signal })).rejects.toThrow('cancelled');
  expect(await fs.readFile(join(directory, 'install.json'), 'utf8')).toBe(before);
  expect(await fs.readFile(join(f.homeDir, '.afk', 'plugins.yml'), 'utf8')).toBe(config);
  expect((await readInstalledPlugin(directory))?.id).toBe(previous.id);
  const restored = await createDefaultPluginRuntime({ homeDir: f.homeDir, workspaceRoot: f.workspaceRoot });
  try { expect(await restored.getVerificationProvider('playwright-managed')!.verify({ target: f.workspaceRoot })).toMatchObject({ passed: true, output: 'managed-fixture:test' }); }
  finally { await restored.dispose(); }
});

it.each(['integrity', 'version', 'resolved', 'extra', 'dependency', 'lock-rewrite', 'symlink', 'missing-cli', 'architecture'])('rejects a changed %s closure before switching the installation', async field => {
  const f = await fixture();
  const materialize = f.runNpm.getMockImplementation()!;
  f.runNpm.mockImplementationOnce(async (args, cwd) => {
    await materialize(args, cwd);
    const path = join(cwd, 'node_modules', '.package-lock.json');
    const lock = JSON.parse(await fs.readFile(path, 'utf8'));
    if (field === 'integrity') lock.packages['node_modules/playwright-core'].integrity = 'sha512-bad';
    if (field === 'version') lock.packages['node_modules/playwright-core'].version = '2.0.0';
    if (field === 'resolved') lock.packages['node_modules/playwright-core'].resolved = 'https://evil.example/core.tgz';
    if (field === 'extra') { lock.packages['node_modules/extra'] = {}; await fs.mkdir(join(cwd, 'node_modules', 'extra')); }
    if (field === 'dependency') await fs.writeFile(join(cwd, 'node_modules', 'playwright', 'package.json'), JSON.stringify({ name: 'playwright', version: '1.62.1', dependencies: { extra: '1' } }));
    if (field === 'lock-rewrite') await fs.appendFile(join(cwd, 'package-lock.json'), '\n');
    if (field === 'symlink') { const cli = join(cwd, 'node_modules', '@playwright', 'test', 'cli.js'); await fs.unlink(cli); await fs.symlink(join(f.root, 'outside'), cli); await fs.writeFile(join(f.root, 'outside'), 'process.exit(0);'); }
    if (field === 'missing-cli') await fs.unlink(join(cwd, 'node_modules', '@playwright', 'test', 'cli.js'));
    if (field === 'architecture') {
      const path = join(cwd, 'node_modules', 'playwright-core', 'package.json');
      const data = JSON.parse(await fs.readFile(path, 'utf8')); data.cpu = ['impossible-architecture'];
      await fs.writeFile(path, JSON.stringify(data));
    }
    await fs.writeFile(path, JSON.stringify(lock));
  });
  await expect(f.manager.installTool('browser-check-1.62.1', { target: 'host-local', offline: true })).rejects.toThrow();
  expect(readPluginConfiguration(f.homeDir).plugins).toEqual([]);
});

it('retains owned cleanup and rejects further activation while an invocation has not settled', async () => {
  const f = await fixture();
  const record = await f.manager.installTool('browser-check-1.62.1', { target: 'host-local', offline: true });
  const packageRoot = dirname(join(f.homeDir, '.afk', 'plugins', record.id, record.entry));
  let finish!: () => void, started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const plugin = await createManagedPlaywrightPlugin({ configuration: { execution: 'host-local' }, homeDir: f.homeDir, workspaceRoot: f.workspaceRoot, packageRoot,
    runner: async (_argv, options) => {
      started(); await finished;
      if (options.signal?.aborted) throw options.signal.reason;
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  const runtime = new PluginRuntime();
  const activation = await f.manager.beginActivation(record.id);
  await runtime.load(plugin, activation.release);
  await f.manager.confirmActivation(record.id, record, activation.entry);
  const provider = runtime.getVerificationProvider('playwright-managed')!;
  const operation = provider.verify({ target: f.workspaceRoot }).catch(error => error);
  await running;
  try {
    await expect(runtime.dispose(record.id)).rejects.toThrow('failed to dispose');
    expect(runtime.hasPendingCleanup(record.id)).toBe(true);
    expect(runtime.getVerificationProvider('playwright-managed')).toBeUndefined();
    await expect(provider.verify({ target: f.workspaceRoot })).rejects.toThrow('disposed');
    await expect(f.manager.remove(record.id)).rejects.toThrow(/active/);
    await expect(f.manager.installTool('browser-check-1.62.1', { target: 'host-local', offline: true })).rejects.toThrow(/active/);
  } finally {
    finish(); await operation; await runtime.dispose(record.id);
  }
  expect(runtime.hasPendingCleanup(record.id)).toBe(false);
  const retry = await createDefaultPluginRuntime({ homeDir: f.homeDir, workspaceRoot: f.workspaceRoot });
  try { expect(await retry.getVerificationProvider('playwright-managed')!.verify({ target: f.workspaceRoot })).toMatchObject({ passed: true }); }
  finally { await retry.dispose(); }
});

it('preserves installation and releases the manager lock after cancellation during npm staging', async () => {
  const f = await fixture(), stop = new AbortController();
  const materialize = f.runNpm.getMockImplementation()!;
  const original = await f.manager.installTool('browser-check-1.62.1', { target: 'host-local', offline: true });
  const bytes = await fs.readFile(join(f.homeDir, '.afk', 'plugins', original.id, 'install.json'), 'utf8');
  f.runNpm.mockImplementationOnce(async (args, cwd) => { await materialize(args, cwd); stop.abort(new Error('cancelled during stage')); });
  await expect(f.manager.installTool('browser-check-1.62.1', { target: 'host-local', offline: true, signal: stop.signal })).rejects.toThrow('cancelled during stage');
  expect(await fs.readFile(join(f.homeDir, '.afk', 'plugins', original.id, 'install.json'), 'utf8')).toBe(bytes);
  await expect(fs.stat(join(f.homeDir, '.afk', 'plugins', '.manager.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects a managed plugin identity supplied through the arbitrary local install path', async () => {
  const f = await fixture();
  const source = join(f.root, 'unapproved');
  await fs.mkdir(source);
  await fs.writeFile(join(source, 'package.json'), '{"type":"module"}');
  await fs.writeFile(join(source, 'plugin.json'), JSON.stringify({ id: 'verification.playwright-managed', version: '0.1.0', apiVersion: 1, trusted: true, provides: ['verification.provider'], entry: 'index.mjs' }));
  await fs.writeFile(join(source, 'index.mjs'), 'throw new Error("unapproved code");');
  await expect(f.manager.install(source)).rejects.toThrow(/recipe|reserved/);
  expect(readPluginConfiguration(f.homeDir).plugins).toEqual([]);
});

it('detects transitive dependency byte tampering even when the wrapper entry is unchanged', async () => {
  const f = await fixture();
  const record = await f.manager.installTool('browser-check-1.62.1', { target: 'host-local', offline: true });
  const directory = join(f.homeDir, '.afk', 'plugins', record.id);
  const packageRoot = dirname(join(directory, record.entry));
  await fs.appendFile(join(packageRoot, 'node_modules', 'playwright-core', 'dependency.js'), 'tampered');
  const runtime = await createDefaultPluginRuntime({ homeDir: f.homeDir, workspaceRoot: f.workspaceRoot });
  try {
    expect(runtime.getVerificationProvider('playwright-managed')).toBeUndefined();
    expect((await runtime.diagnostics()).some(item => /seal|closure|integrity/.test(item.message))).toBe(true);
  } finally { await runtime.dispose(); }
});

it('marks a damaged prior tool closure unusable and retains recovery when both closures fail', async () => {
  const f = await fixture();
  const previous = await f.manager.installTool('browser-check-1.62.1', { target: 'host-local', offline: true });
  const parent = join(f.homeDir, '.afk', 'plugins'), directory = join(parent, previous.id);
  await fs.appendFile(join(dirname(join(directory, previous.entry)), 'node_modules/playwright-core/dependency.js'), 'prior damage');
  const next = await f.manager.installTool('browser-check-1.62.1', { target: 'host-local', offline: true });
  const journal = join(parent, '.pending-' + previous.id + '.json');
  const pending = JSON.parse(await fs.readFile(journal, 'utf8'));
  expect(pending.previousUsable).toBe(false);
  await fs.appendFile(join(dirname(join(directory, next.entry)), 'node_modules/playwright-core/dependency.js'), 'next damage');
  const runtime = await createDefaultPluginRuntime({ homeDir: f.homeDir, workspaceRoot: f.workspaceRoot });
  try {
    expect(runtime.getVerificationProvider('playwright-managed')).toBeUndefined();
    expect((await runtime.diagnostics()).some(item => /Previous installation was damaged/.test(item.message))).toBe(true);
    expect(JSON.parse(await fs.readFile(journal, 'utf8')).next.toolReceipt).toBe(next.toolReceipt);
  } finally { await runtime.dispose(); }
});

it('retains concurrent configuration changes and the prior module during a staged install', async () => {
  const f = await fixture();
  const previous = await f.manager.installTool('browser-check-1.62.1', { target: 'host-local', offline: true });
  const materialize = f.runNpm.getMockImplementation()!, configPath = join(f.homeDir, '.afk', 'plugins.yml');
  const recordPath = join(f.homeDir, '.afk', 'plugins', previous.id, 'install.json'), before = await fs.readFile(recordPath, 'utf8');
  let manual = '';
  f.runNpm.mockImplementationOnce(async (args, cwd) => {
    await materialize(args, cwd);
    const configuration = readPluginConfiguration(f.homeDir);
    configuration.plugins.push({ id: 'unrelated.manual', enabled: false, config: { preserved: true } });
    manual = JSON.stringify(configuration);
    await fs.writeFile(configPath, manual);
  });
  await expect(f.manager.installTool('browser-check-1.62.1', { target: 'host-local', offline: true })).rejects.toThrow('changed concurrently');
  expect(await fs.readFile(recordPath, 'utf8')).toBe(before);
  expect(await fs.readFile(configPath, 'utf8')).toBe(manual);
});

it('ships every hash-bound recipe asset through official production package deployment', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { createHash } = await import('node:crypto');
  const { TOOL_ASSETS, prepareToolStage } = await import('./tool-recipes.js');
  const { TOOL_ASSET_HASHES } = await import('./tool-asset-hashes.js');
  const f = await fixture(), workspace = join(f.root, 'packaging');
  const runtime = join(workspace, 'runtime'), cli = join(workspace, 'cli');
  const resourcePath = 'dist/application/plugins/tool-assets/playwright';
  await fs.mkdir(join(runtime, resourcePath), { recursive: true });
  await fs.mkdir(join(cli, 'dist'), { recursive: true });
  await fs.writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'afk-tool-deploy-workspace', private: true, version: '0.1.0' }));
  await fs.writeFile(join(workspace, 'pnpm-workspace.yaml'), 'packages:\n  - runtime\n  - cli\n');
  await fs.writeFile(join(runtime, 'package.json'), JSON.stringify({ name: 'afk-tool-runtime-fixture', version: '0.1.0', private: true, files: ['dist'] }));
  await fs.writeFile(join(cli, 'package.json'), JSON.stringify({ name: 'afk-tool-cli-fixture', version: '0.1.0', private: true, files: ['dist'], dependencies: { 'afk-tool-runtime-fixture': 'workspace:*' } }));
  await fs.writeFile(join(cli, 'dist/index.js'), 'process.exitCode = 0;');
  await fs.cp(TOOL_ASSETS, join(runtime, resourcePath), { recursive: true });
  const destination = join(f.root, 'deployed');
  const args = [
    '--filter', 'afk-tool-cli-fixture', 'deploy', '--legacy', '--prod', '--ignore-scripts', '--ignore-pnpmfile', '--offline',
    '--config.hoist=false', '--config.force=false', '--config.userconfig=/dev/null',
    '--store-dir', join(f.root, 'store'), `--config.state-dir=${join(f.root, 'state')}`, destination,
  ];
  const result = await promisify(execFile)('pnpm', args, { cwd: workspace, timeout: 30000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, HOME: join(f.root, 'package-home'), TMPDIR: f.root, CI: 'true', PNPM_HOME: join(f.root, 'pnpm-home'), XDG_CACHE_HOME: join(f.root, 'cache'), XDG_STATE_HOME: join(f.root, 'state'), XDG_DATA_HOME: join(f.root, 'data') } });
  const deployed = join(destination, 'node_modules/afk-tool-runtime-fixture', resourcePath);
  const files = (await fs.readdir(deployed)).sort();
  const expected = (await fs.readdir(TOOL_ASSETS)).sort();
  expect(files).toEqual(expected);
  for (const name of files) expect(await fs.readFile(join(deployed, name))).toEqual(await fs.readFile(join(TOOL_ASSETS, name)));
  const stage = join(f.root, 'stage/package');
  await fs.cp(deployed, stage, { recursive: true });
  await prepareToolStage(stage, { target: 'host-local' });
  expect((await fs.readdir(stage)).sort()).toEqual(Object.keys(TOOL_ASSET_HASHES).sort());
  for (const [name, hash] of Object.entries(TOOL_ASSET_HASHES)) expect(createHash('sha256').update(await fs.readFile(join(stage, name))).digest('hex')).toBe(hash);
  const corrupt = join(f.root, 'corrupt/package');
  await fs.cp(deployed, corrupt, { recursive: true });
  await fs.appendFile(join(corrupt, 'npm-lock.json'), '\n');
  await expect(prepareToolStage(corrupt, { target: 'host-local' })).rejects.toThrow(/integrity/);
  const extra = join(f.root, 'extra/package');
  await fs.cp(deployed, extra, { recursive: true });
  await fs.writeFile(join(extra, '.npmrc'), 'registry=https://unapproved.invalid/');
  await expect(prepareToolStage(extra, { target: 'host-local' })).rejects.toThrow(/Unexpected/);
  console.log(JSON.stringify({ check: 'official-deploy-assets', files, canonicalStageFiles: (await fs.readdir(stage)).sort(), args, stdout: result.stdout, stderr: result.stderr }));
});

it('uses the saved production verification selection with only each trusted managed worktree authorized', async () => {
  const f = await fixture(), log = join(f.root, 'managed-invocations.jsonl');
  const materialize = f.runNpm.getMockImplementation()!;
  f.runNpm.mockImplementationOnce(async (args, cwd) => {
    await materialize(args, cwd);
    await fs.writeFile(join(cwd, 'node_modules/@playwright/test/cli.js'), `require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), cli: __filename, argv: process.argv.slice(2) }) + String.fromCharCode(10)); process.stdout.write('managed-worktree:test');`);
  });
  const record = await f.manager.installTool('browser-check-1.62.1', { target: 'host-local', offline: true });
  const worktrees = [join(f.homeDir, '.loop-workspace/item-a/repo'), join(f.homeDir, '.loop-workspace/item-b/repo')];
  for (const path of worktrees) await fs.mkdir(path, { recursive: true });
  const configuration = readPluginConfiguration(f.homeDir);
  configuration.integrations = { verifications: [{ provider: 'playwright-managed' }] };
  await fs.writeFile(join(f.homeDir, '.afk/plugins.yml'), JSON.stringify(configuration));
  const runtime = await createDefaultPluginRuntime({ homeDir: f.homeDir, workspaceRoot: f.workspaceRoot });
  const request = (target: string) => ({ capability: 'verification.provider', provider: 'playwright-managed', operation: 'verify', input: { target } });
  try {
    await expect(invokeCapability(runtime, request(worktrees[0]))).rejects.toThrow(/escapes/);
    await expect(invokeCapability(runtime, { ...request(worktrees[0]), input: { target: worktrees[0], authorizedWorkspace: worktrees[0] } })).rejects.toThrow(/Invalid/);
    await expect(invokeCapability(runtime, { ...request(worktrees[0]), authorizedWorkspace: worktrees[0] })).rejects.toThrow(/Invalid/);
    const lifecycle = new LifecycleDispatcher(runtime.getLifecycleModules());
    await Promise.all(worktrees.map(async worktreePath => lifecycle.run('before-publish', await observedWorkspace(runtime, worktreePath, f.root))));
    await expect(invokeCapability(runtime, request(worktrees[0]))).rejects.toThrow(/escapes/);
    const { SystemActionExecutor } = await import('../workflows/system-actions.js');
    const executor = new SystemActionExecutor({ plugins: runtime, publishChange: async () => undefined, queueQA: async () => undefined });
    await expect(runtime.dispatchSystemAction('capability.invoke', { input: request(worktrees[0]), worktreePath: worktrees[0] })).rejects.toThrow(/escapes/);
    await expect(executor.execute('capability.invoke', { input: request(worktrees[0]), worktreePath: worktrees[0] }, { authorizedWorkspace: worktrees[0] })).resolves.toMatchObject({ passed: true, output: 'managed-worktree:test' });
    await expect(executor.execute('capability.invoke', { input: request(worktrees[1]), worktreePath: worktrees[0] }, { authorizedWorkspace: worktrees[0] })).rejects.toThrow(/escapes/);
    await fs.symlink(worktrees[1], join(worktrees[0], 'escape'));
    await expect(executor.execute('capability.invoke', { input: request(join(worktrees[0], 'escape')), worktreePath: worktrees[0] }, { authorizedWorkspace: worktrees[0] })).rejects.toThrow(/escapes/);
    await expect(executor.execute('capability.invoke', { input: { ...request(worktrees[0]), input: { target: worktrees[0], command: ['unapproved'] } }, worktreePath: worktrees[0] }, { authorizedWorkspace: worktrees[0] })).rejects.toThrow(/command/);
    const rows = (await fs.readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { cwd: string; cli: string; argv: string[] });
    expect(rows.map(row => row.cwd).sort()).toEqual((await Promise.all([...worktrees, worktrees[0]].map(path => fs.realpath(path)))).sort());
    for (const row of rows) {
      expect(row.argv).toEqual(['test']);
      expect(row.cli).toBe(await fs.realpath(join(dirname(join(f.homeDir, '.afk/plugins', record.id, record.entry)), 'node_modules/@playwright/test/cli.js')));
    }
    console.log(JSON.stringify({ check: 'saved-managed-worktree-selection', invocations: rows }));
  } finally { await runtime.dispose(); }
});

it('keeps action JSON untrusted while explicit engine and SDK action options authorize only the current worktree', async () => {
  const { SystemActionExecutor } = await import('../workflows/system-actions.js');
  const { registerVerificationSystemActions } = await import('./integrations.js');
  const f = await fixture();
  await f.manager.installTool('browser-check-1.62.1', { target: 'host-local', offline: true });
  const worktree = join(f.homeDir, '.loop-workspace/item/repo'), peer = join(f.homeDir, '.loop-workspace/peer/repo');
  await fs.mkdir(worktree, { recursive: true }); await fs.mkdir(peer, { recursive: true });
  const runtime = await createDefaultPluginRuntime({ homeDir: f.homeDir, workspaceRoot: f.workspaceRoot });
  const request = (target: string) => ({ capability: 'verification.provider', provider: 'playwright-managed', operation: 'verify', input: { target } });
  const envelope = { worktreePath: worktree, input: request(worktree) };
  const executor = new SystemActionExecutor({ plugins: runtime, publishChange: async () => undefined, queueQA: async () => undefined });
  try {
    for (const input of [envelope, { ...envelope, authorizedWorkspace: worktree }, { ...envelope, options: { authorizedWorkspace: worktree } }]) {
      await expect(runtime.dispatchSystemAction('capability.invoke', JSON.parse(JSON.stringify(input)))).rejects.toThrow(/escapes/);
      await expect(executor.execute('capability.invoke', JSON.parse(JSON.stringify(input)))).rejects.toThrow(/escapes/);
    }
    await expect(executor.execute('capability.invoke', envelope, { authorizedWorkspace: worktree })).resolves.toMatchObject({ passed: true });
    await expect(executor.execute('capability.invoke', { worktreePath: peer, input: request(peer) }, { authorizedWorkspace: worktree })).rejects.toThrow(/escapes/);
    await expect(runtime.dispatchSystemAction('capability.invoke', envelope)).rejects.toThrow(/escapes/);
    const missingTarget = { worktreePath: peer, input: { ...request(peer), input: {} } };
    await expect(executor.execute('capability.invoke', missingTarget, { authorizedWorkspace: worktree })).resolves.toMatchObject({ passed: true });
    const stop = new AbortController(); stop.abort(new Error('cancelled trusted action'));
    await expect(executor.execute('capability.invoke', envelope, { authorizedWorkspace: worktree, signal: stop.signal })).rejects.toThrow('cancelled trusted action');
    await runtime.load({ manifest: { id: 'workflow.tool-test', version: '0.1.0', apiVersion: 1, provides: ['workflow.action'], trusted: true }, activate: setup => registerVerificationSystemActions(runtime, setup, [{ name: 'tool.verify', provider: 'playwright-managed', request: () => ({ target: worktree }) }]) });
    await expect(runtime.dispatchSystemAction('tool.verify', envelope)).rejects.toThrow(/escapes/);
    await expect(executor.execute('tool.verify', envelope, { authorizedWorkspace: worktree })).resolves.toMatchObject({ passed: true });
    await expect(executor.execute('tool.verify', envelope, { authorizedWorkspace: peer })).rejects.toThrow(/escapes/);
  } finally { await runtime.dispose(); }
});

it('grants service authority from the checked-out Repository workspace rather than its nested input', async () => {
  const f = await fixture();
  await f.manager.installTool('browser-check-1.62.1', { target: 'host-local', offline: true });
  const preparedPath = join(f.root, 'prepared'), checkedOutPath = join(f.homeDir, '.loop-workspace/service/repo'), outside = join(f.root, 'outside');
  for (const path of [preparedPath, checkedOutPath, outside]) await fs.mkdir(path, { recursive: true });
  const runtime = await createDefaultPluginRuntime({ homeDir: f.homeDir, workspaceRoot: f.workspaceRoot });
  const calls: string[] = [];
  const stop = new AbortController();
  const dispatch = vi.spyOn(runtime, 'dispatchSystemAction');
  let checkoutPath: string | undefined = checkedOutPath;
  const workspace = { id: 'ordinary-service-workspace', repository: { url: 'fixture' }, runId: 'ordinary', snapshot: { commit: 'a'.repeat(40), branch: 'fixture', dirty: false }, path: preparedPath };
  await runtime.load({ manifest: { id: 'repository.tool-test', version: '0.1.0', apiVersion: 1, provides: ['repository.provider'], trusted: true }, activate(context) {
    context.registerRepositoryProvider('tool-fixture', {
      id: 'tool-fixture', capabilities: { read: true, clone: false, push: false, prepare: true, checkout: true, publish: true, cleanup: true },
      snapshot: async () => workspace.snapshot,
      prepare: async (_request, options) => { expect(options?.signal).toBe(stop.signal); calls.push('prepare'); return workspace; },
      checkout: async (_request, options) => { expect(options?.signal).toBe(stop.signal); calls.push('checkout'); return { ...workspace, path: checkoutPath }; },
      publish: async () => { calls.push('publish'); return workspace.snapshot; },
      cleanup: async () => { calls.push('cleanup'); return { removed: true }; },
    });
  } });
  const request = (target: string) => ({ capability: 'verification.provider', provider: 'playwright-managed', operation: 'verify', input: { target } });
  const run = (target: string) => invokeCapability(runtime, { capability: 'repository.provider', provider: 'tool-fixture', operation: 'run', input: { repository: { url: 'fixture' }, runId: 'ordinary', action: 'capability.invoke', input: request(target) } }, { signal: stop.signal, authorizedWorkspace: outside });
  try {
    await expect(run(checkedOutPath)).resolves.toMatchObject({ value: { passed: true }, workspace: { path: checkedOutPath } });
    expect(dispatch.mock.calls.at(-1)?.[2]).toEqual({ signal: stop.signal, authorizedWorkspace: checkedOutPath });
    expect(calls.splice(0)).toEqual(['prepare', 'checkout', 'publish', 'cleanup']);
    for (const path of [preparedPath, outside]) {
      await expect(run(path)).rejects.toThrow(/escapes/);
      expect(calls.splice(0)).toEqual(['prepare', 'checkout', 'cleanup']);
    }
    checkoutPath = undefined;
    await expect(run(checkedOutPath)).rejects.toThrow(/authorized.*workspace/);
    expect(dispatch.mock.calls.at(-1)?.[2]).toEqual({ signal: stop.signal, authorizedWorkspace: undefined });
    expect(calls.splice(0)).toEqual(['prepare', 'checkout', 'cleanup']);
    await expect(run(outside)).rejects.toThrow(/authorized.*workspace/);
    expect(calls.splice(0)).toEqual(['prepare', 'checkout', 'cleanup']);
    await expect(run(f.workspaceRoot)).rejects.toThrow(/authorized.*workspace/);
    expect(calls.splice(0)).toEqual(['prepare', 'checkout', 'cleanup']);
    await expect(invokeCapability(runtime, request(checkedOutPath))).rejects.toThrow(/escapes/);
  } finally { await runtime.dispose(); }
});

it('removes private npm state from the precreated version directory before publication', async () => {
  const f = await fixture();
  const manager = new PluginManager({ homeDir: f.homeDir, runNpm: async (args, cwd, options) => {
    await f.runNpm(args, cwd);
    expect(options?.env?.HOME).toBe(join(dirname(cwd), '.npm-home'));
    expect(options?.env?.npm_config_cache).toBe(join(dirname(cwd), '.npm-cache'));
    for (const name of ['.npm-home', '.npm-cache']) {
      const path = join(dirname(cwd), name);
      await fs.mkdir(path);
      await fs.writeFile(join(path, 'inert-fixture'), 'private fixture state');
    }
  } });
  const record = await manager.installTool('browser-check-1.62.1', { target: 'host-local', offline: true });
  const version = dirname(dirname(join(f.homeDir, '.afk/plugins', record.id, record.entry)));
  expect((await fs.readdir(version)).sort()).toEqual(['package']);
});

it.each(['git-push', 'issue-event', 'webhook', 'schedule'] as const)('keeps public %s trigger JSON outside the execution authority channel', async kind => {
  const { GitPushTriggerProvider, IssueEventTriggerProvider, WebhookTriggerProvider, ScheduleTriggerProvider } = await import('../../infrastructure/providers/triggers.js');
  const f = await fixture();
  await f.manager.installTool('browser-check-1.62.1', { target: 'host-local', offline: true });
  const outside = join(f.root, 'unrelated'); await fs.mkdir(outside);
  const id = 'trigger.' + kind;
  vi.stubEnv('D02_LOCAL_WEBHOOK_FIXTURE', 'ordinary-fixture-value');
  const configuration = readPluginConfiguration(f.homeDir);
  const triggers = kind === 'schedule' ? [{ id: 'initial', kind: 'schedule', schedule: '3600000' }] : [{ id: 'initial', kind: 'webhook', payload: { branch: 'never', event: 'never', action: 'never' } }];
  configuration.plugins.push({ id, builtin: true, action: 'capability.invoke', config: { triggers, ...(kind === 'webhook' ? { secret: { env: 'D02_LOCAL_WEBHOOK_FIXTURE' } } : {}) } });
  await fs.writeFile(join(f.homeDir, '.afk/plugins.yml'), JSON.stringify(configuration));
  vi.useFakeTimers();
  const runtime = await createDefaultPluginRuntime({ homeDir: f.homeDir, workspaceRoot: f.workspaceRoot, activateTriggers: true, queueOptions: { maxAttempts: 1 } });
  expect(runtime.getTriggerProvider(id), JSON.stringify(await runtime.diagnostics())).toBeDefined();
  const provider = runtime.getVerificationProvider('playwright-managed')!;
  const execute = vi.spyOn(provider, 'verify');
  const request = { capability: 'verification.provider', provider: 'playwright-managed', operation: 'verify', input: { target: outside } };
  const injected = JSON.parse(JSON.stringify({ worktreePath: outside, authorizedWorkspace: outside, options: { authorizedWorkspace: outside }, input: request }));
  try {
    const descriptor = { id: 'public-json', kind: kind === 'schedule' ? 'schedule' : 'webhook', ...(kind === 'schedule' ? { schedule: '1000' } : {}), input: injected };
    await invokeCapability(runtime, { capability: 'trigger.provider', provider: id, operation: 'register', input: descriptor });
    const trigger = runtime.getTriggerProvider(id)!;
    if (trigger instanceof GitPushTriggerProvider) await expect(trigger.handlePush({ ref: 'refs/heads/main' })).rejects.toThrow('Configured trigger action failed');
    else if (trigger instanceof IssueEventTriggerProvider) await expect(trigger.handleIssue({ action: 'opened' })).rejects.toThrow('Configured trigger action failed');
    else if (trigger instanceof WebhookTriggerProvider) await expect(trigger.handleAuthenticatedPayload({ name: 'ordinary', payload: {} })).rejects.toThrow('Configured trigger action failed');
    else if (trigger instanceof ScheduleTriggerProvider) {
      const { pluginTriggerQueue } = await import('./listener.js');
      await vi.advanceTimersByTimeAsync(1000);
      expect(pluginTriggerQueue(runtime)!.status()).toEqual([expect.objectContaining({ providerId: id, status: 'pending', attempts: 0 })]);
      expect(execute).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await trigger.dispose();
      await vi.waitFor(() => expect(pluginTriggerQueue(runtime)!.status()).toEqual([expect.objectContaining({ providerId: id, status: 'failed', attempts: 1 })]));
      expect((await trigger.health()).status).toBe('ok');
    } else throw new Error('Unexpected fixture trigger');
    expect(execute).toHaveBeenCalled();
    expect(execute.mock.calls.every(([, options]) => options === undefined)).toBe(true);
    expect((await runtime.diagnostics()).some(item => item.pluginId === id && item.code === 'trigger.action-failed')).toBe(true);
    await expect(invokeCapability(runtime, request)).rejects.toThrow(/escapes/);
  } finally { await runtime.dispose(); vi.useRealTimers(); vi.unstubAllEnvs(); }
});
});
