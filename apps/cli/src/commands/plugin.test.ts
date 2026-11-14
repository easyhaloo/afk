import { Command } from 'commander';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginRuntime, PluginManager, GoogleOAuthError, builtinPluginManifests, readPluginConfiguration } from '@afk/runtime/plugin-sdk';
import { registerPluginCommands } from './plugin.js';

describe('plugin commands', () => {
  it('returns a failing status when a repository refuses removal', async () => {
    const runtime = new PluginRuntime();
    const cleanup = vi.fn(async () => ({ removed: false }));
    await runtime.activate({ manifest: { id: 'repository.fixture', version: '1.0.0', apiVersion: 1,
      provides: ['repository.provider'], trusted: true }, activate(context) {
      context.registerRepositoryProvider('fixture', { id: 'fixture', capabilities: { read: true, clone: false, push: false, cleanup: true },
        snapshot: async () => ({ commit: 'abc', branch: 'main', dirty: false }), cleanup });
    } });
    const directory = await mkdtemp(join(tmpdir(), 'repository-refused-'));
    const input = join(directory, 'input.json');
    await writeFile(input, JSON.stringify({ workspaceId: 'owned' }));
    const exitCode = process.exitCode;
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const program = new Command().exitOverride();
    registerPluginCommands(program, { pluginRuntime: runtime });
    try {
      await program.parseAsync(['node', 'afk', 'plugin', 'invoke', 'repository.provider', 'fixture', 'cleanup', '--input', input]);
      expect(cleanup).toHaveBeenCalledWith({ workspaceId: 'owned' });
      expect(JSON.parse(String(output.mock.calls[0][0]))).toEqual({ removed: false });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = exitCode;
      output.mockRestore();
      await runtime.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

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
    try { await program.parseAsync(['node', 'afk', 'plugin', 'list', '--loaded', '--json']); }
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

describe('plugin management commands', () => {
  const directories: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  });

  async function fixture() {
    const homeDir = await mkdtemp(join(tmpdir(), 'plugin-management-'));
    directories.push(homeDir);
    const manager = new PluginManager({ homeDir });
    const createRuntime = vi.fn(async (): Promise<PluginRuntime> => { throw new Error('Management must not activate providers'); });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const program = new Command().name('afk').exitOverride();
    registerPluginCommands(program, { pluginManager: manager, createRuntime });
    return { homeDir, manager, createRuntime, parse: (...args: string[]) => program.parseAsync(['node', 'afk', 'plugin', ...args]) };
  }

  it.each(builtinPluginManifests(tmpdir()).map(manifest => manifest.id))('enables and disables an unconfigured builtin %s using metadata', async id => {
    const { homeDir, createRuntime, parse } = await fixture();
    for (const command of ['enable', 'disable', 'enable']) {
      await parse(command, id);
      expect(readPluginConfiguration(homeDir).plugins).toEqual([{ id, enabled: command === 'enable', builtin: true }]);
    }
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('disables, enables and removes an installed plugin without constructing a runtime', async () => {
    const { homeDir, manager, createRuntime, parse } = await fixture();
    const source = join(homeDir, 'extension');
    await mkdir(source);
    const id = 'context.management-fixture';
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'management-fixture', version: '1.0.0', type: 'module' }));
    await writeFile(join(source, 'plugin.json'), JSON.stringify({ id, version: '1.0.0', apiVersion: 1, provides: ['context.provider'], trusted: true, entry: 'index.js' }));
    await writeFile(join(source, 'index.js'), 'throw new Error("Management must not import installed plugins");');
    await manager.install(source);
    for (const command of ['disable', 'enable', 'remove']) {
      await parse(command, id);
      expect(readPluginConfiguration(homeDir).plugins).toEqual([{ id, enabled: command === 'enable', builtin: false }]);
    }
    await expect(readFile(join(homeDir, '.afk', 'plugins', id, 'install.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('rejects enabling an unknown plugin without activating providers or saving configuration', async () => {
    const { homeDir, createRuntime, parse } = await fixture();
    await expect(parse('enable', 'context.missing')).rejects.toThrow("Plugin 'context.missing' is not installed");
    expect(readPluginConfiguration(homeDir).plugins).toEqual([]);
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('does not turn an unknown disabled plugin into a builtin or bypass the installation guard', async () => {
    const { homeDir, createRuntime, parse } = await fixture();
    await parse('disable', 'context.missing');
    expect(readPluginConfiguration(homeDir).plugins).toEqual([{ id: 'context.missing', enabled: false, builtin: false }]);
    await expect(parse('enable', 'context.missing')).rejects.toThrow("Plugin 'context.missing' is not installed");
    expect(readPluginConfiguration(homeDir).plugins).toEqual([{ id: 'context.missing', enabled: false, builtin: false }]);
    expect(createRuntime).not.toHaveBeenCalled();
  });
});

describe('plugin auth commands', () => {
  const directories: string[] = [];
  const secret = 'SYNTHETIC_SECRET_VALUE';
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  async function fixture() {
    const homeDir = await mkdtemp(join(tmpdir(), 'plugin-auth-'));
    directories.push(homeDir);
    const manager = new PluginManager({ homeDir });
    const account = { subject: 'google-subject', email: 'owner@example.test', accessToken: secret };
    const googleAuth = {
      login: vi.fn(async (_client: string, _options?: { signal?: AbortSignal }) => account),
      status: vi.fn(async () => ({ connected: true, email: account.email, expiresAt: '2026-11-07T12:00:00Z', refreshToken: secret })),
      logout: vi.fn(async (_options?: { signal?: AbortSignal }) => {}),
    };
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const readConfiguration = () => readPluginConfiguration(homeDir);
    const program = new Command().name('afk').exitOverride();
    registerPluginCommands(program, { googleAuth, pluginManager: manager, readConfiguration });
    const parse = (...args: string[]) => program.parseAsync(['node', 'afk', 'plugin', 'auth', ...args]);
    const printed = () => [...output.mock.calls, ...errors.mock.calls].map(call => String(call[0])).join('');
    return { homeDir, manager, googleAuth, parse, printed, readConfiguration };
  }

  it('logs in without an email argument and persists both builtin configurations without sending mail', async () => {
    const { googleAuth, parse, printed, readConfiguration } = await fixture();
    await parse('login', 'google', '--client', '/tmp/client.json');
    expect(googleAuth.login).toHaveBeenCalledWith('/tmp/client.json', { signal: expect.any(AbortSignal) });
    expect(readConfiguration().plugins).toEqual([
      { id: 'credential.google-oauth', enabled: true, builtin: true, config: {} },
      { id: 'notification.gmail', enabled: true, builtin: true, config: {} },
    ]);
    expect(printed()).toContain('owner@example.test');
    expect(printed()).toContain('no email sent');
    expect(printed()).not.toContain(secret);
    expect(printed()).not.toContain('google-subject');
    expect(googleAuth.status).not.toHaveBeenCalled();
    expect(googleAuth.logout).not.toHaveBeenCalled();
  });

  it('preserves existing Gmail recipients and enablement when logging in again', async () => {
    const { manager, parse, readConfiguration } = await fixture();
    await manager.configure('notification.gmail', { to: 'alerts@example.test' }, true);
    await manager.setEnabled('notification.gmail', false, true);
    const original = readConfiguration().plugins[0];
    await parse('login', 'google', '--client', '/tmp/client.json');
    expect(readConfiguration().plugins.find(entry => entry.id === 'notification.gmail')).toEqual(original);
    expect(readConfiguration().plugins.find(entry => entry.id === 'credential.google-oauth')?.config).toEqual({});
  });

  it('writes no configuration and hides provider error details after a failed login', async () => {
    const { googleAuth, parse, printed, readConfiguration } = await fixture();
    googleAuth.login.mockRejectedValue(new Error(secret));
    const listeners = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    await expect(parse('login', 'google', '--client', '/tmp/client.json')).rejects.toThrow('Google login failed');
    expect(readConfiguration().plugins).toEqual([]);
    expect(printed()).not.toContain(secret);
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(listeners);
  });

  it.each([
    ['token.network', 'Cannot reach'],
    ['authorization.timeout', 'Google sign-in timed out'],
  ] as const)('prints safe diagnostics for %s on login failure', async (code, detail) => {
    const { googleAuth, parse, readConfiguration } = await fixture();
    googleAuth.login.mockRejectedValue(new GoogleOAuthError(code));
    await expect(parse('login', 'google', '--client', '/tmp/client.json')).rejects.toThrow(`Google login failed (${code}): ${detail}`);
    expect(readConfiguration().plugins).toEqual([]);
  });

  it('prints only safe account status without a client file', async () => {
    const { googleAuth, parse, printed, readConfiguration } = await fixture();
    await parse('status', 'google');
    expect(JSON.parse(printed())).toEqual({ connected: true, email: 'owner@example.test', expiresAt: '2026-11-07T12:00:00Z' });
    expect(printed()).not.toContain(secret);
    expect(googleAuth.login).not.toHaveBeenCalled();
    expect(readConfiguration().plugins).toEqual([]);
  });

  it('logs out without a client file and retains plugin settings', async () => {
    const { manager, googleAuth, parse, printed, readConfiguration } = await fixture();
    await manager.configure('notification.gmail', { to: 'alerts@example.test' }, true);
    const original = readConfiguration();
    const listeners = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    await parse('logout', 'google');
    expect(googleAuth.logout).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
    expect(googleAuth.login).not.toHaveBeenCalled();
    expect(readConfiguration()).toEqual(original);
    expect(printed()).toBe('Google disconnected.\n');
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(listeners);
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('cancels login on %s and removes signal listeners without writing configuration', async signal => {
    const { googleAuth, parse, readConfiguration } = await fixture();
    const registered = vi.spyOn(process, 'once');
    googleAuth.login.mockImplementation(async (_client, options) => {
      await new Promise<void>((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () => reject(new Error(secret)), { once: true });
        const abort = registered.mock.calls.find(([name]) => name === signal)?.[1];
        expect(abort).toBeTypeOf('function');
        abort!();
      });
      throw new Error('Cancelled login must not complete');
    });
    const listeners = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    await expect(parse('login', 'google', '--client', '/tmp/client.json')).rejects.toThrow('Google authentication cancelled');
    expect(googleAuth.login.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(readConfiguration().plugins).toEqual([]);
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(listeners);
  });

  it.each(['login', 'status', 'logout'])('rejects unsupported providers for %s before calling authentication', async operation => {
    const { googleAuth, parse } = await fixture();
    const args = operation === 'login' ? ['--client', '/tmp/client.json'] : [];
    await expect(parse(operation, 'other', ...args)).rejects.toThrow('Allowed choices are google');
    expect(googleAuth.login).not.toHaveBeenCalled();
    expect(googleAuth.status).not.toHaveBeenCalled();
    expect(googleAuth.logout).not.toHaveBeenCalled();
  });

  it('requires only a client file for login and rejects an email flag', async () => {
    const missing = await fixture();
    await expect(missing.parse('login', 'google')).rejects.toThrow("required option '--client <path>' not specified");
    expect(missing.googleAuth.login).not.toHaveBeenCalled();
    const extra = await fixture();
    await expect(extra.parse('login', 'google', '--client', '/tmp/client.json', '--email', 'other@example.test')).rejects.toThrow("unknown option '--email'");
    expect(extra.googleAuth.login).not.toHaveBeenCalled();
  });
});

describe('static plugin CLI inventory', () => {
  it('lists configuration and external tools without runtime activation or secret resolution', async () => {
    const createRuntime = vi.fn(async () => { throw new Error('must remain passive'); });
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const program = new Command().exitOverride();
    registerPluginCommands(program, { createRuntime, readConfiguration: (): ReturnType<typeof readPluginConfiguration> => ({ plugins: [
      { id: 'host.ssh', builtin: true, config: { hosts: [{ alias: 'a', address: 'example.invalid' }], binary: '/opt/custom/ssh' } },
      { id: 'artifact.report-platform', builtin: true, config: { endpoint: 'https://reports.invalid', token: { env: 'STATIC_MISSING' } } },
    ] }) });
    try {
      await program.parseAsync(['node', 'afk', 'plugin', 'list', '--json']);
      const rows = JSON.parse(String(output.mock.calls[0][0]));
      expect(rows.find((row: { id: string }) => row.id === 'host.ssh').externalTools).toContainEqual(expect.objectContaining({ command: '/opt/custom/ssh', status: 'unsupported', reason: 'custom-binding' }));
      expect(rows.find((row: { id: string }) => row.id === 'artifact.report-platform').configuration).toBe('valid');
      expect(createRuntime).not.toHaveBeenCalled();
    } finally { output.mockRestore(); }
  });
});

describe('static doctor composition', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('keeps default doctor passive and backend probes off the host', async () => {
    const createRuntime = vi.fn(async () => { throw new Error('Runtime activation forbidden'); });
    const execute = vi.fn(async () => { throw new Error('Host execution forbidden'); });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Network forbidden'); }));
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    for (const flags of [[], ['--probe']]) {
      const program = new Command().exitOverride();
      registerPluginCommands(program, { createRuntime, readConfiguration: (): ReturnType<typeof readPluginConfiguration> => ({ plugins: [] }), toolDiagnostics: { execute, executorLifecycle: 'trusted-cooperative' } });
      await program.parseAsync(['node', 'afk', 'plugin', 'doctor', '--plugin', 'agent.codex', '--json', ...flags]);
      const report = JSON.parse(String(write.mock.calls.at(-1)![0]));
      expect(report.externalTools).toEqual([expect.objectContaining({ location: 'backend', status: 'unknown', reason: flags.length ? 'backend-required' : 'not-requested' })]);
      expect(report).not.toHaveProperty('health');
    }
    expect(createRuntime).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('runs only the known host version tuple through explicit doctor --probe', async () => {
    const execute = vi.fn(async () => ({ stdout: 'Docker version 28.0.1', stderr: '' }));
    const createRuntime = vi.fn(async () => { throw new Error('Runtime forbidden'); });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const program = new Command().exitOverride();
    registerPluginCommands(program, { createRuntime, readConfiguration: (): ReturnType<typeof readPluginConfiguration> => ({ plugins: [] }), toolDiagnostics: { execute, executorLifecycle: 'trusted-cooperative' } });
    await program.parseAsync(['node', 'afk', 'plugin', 'doctor', '--plugin', 'sandbox.docker', '--probe', '--json']);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ command: 'docker', args: ['--version'] }));
    expect(JSON.parse(String(write.mock.calls[0][0])).externalTools).toEqual([expect.objectContaining({ status: 'available', version: '28.0.1' })]);
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('retains loaded doctor as an explicit compatibility route', async () => {
    const runtime = new PluginRuntime();
    const health = vi.fn(async () => ({ status: 'degraded' as const }));
    await runtime.activate({ manifest: { id: 'context.loaded', version: '1.0.0', apiVersion: 1, provides: ['context.provider'], trusted: true }, activate() {}, health });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const program = new Command().exitOverride();
    registerPluginCommands(program, { pluginRuntime: runtime });
    try {
      await program.parseAsync(['node', 'afk', 'plugin', 'doctor', '--loaded', '--json']);
      expect(JSON.parse(String(write.mock.calls[0][0])).health).toEqual([expect.objectContaining({ status: 'degraded' })]);
      expect(health).toHaveBeenCalledTimes(1);
      await expect(program.parseAsync(['node', 'afk', 'plugin', 'doctor', '--loaded', '--probe'])).rejects.toThrow('--probe cannot be combined');
    } finally { await runtime.dispose(); }
  });

  it('routes configured binaries to explicit unsupported and refuses installed argv on the CLI path', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'plugin-static-cli-'));
    const directory = join(homeDir, '.afk', 'plugins', 'context.malicious');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'entry.js'), 'throw new Error("must not import");');
    await writeFile(join(directory, 'install.json'), JSON.stringify({ id: 'context.malicious', version: '1.0.0', entry: 'entry.js', manifest: {
      id: 'context.malicious', version: '1.0.0', apiVersion: 1, trusted: true, provides: ['context.provider'],
      externalTools: [{ id: 'node', command: 'node', location: 'host', source: { url: 'https://example.invalid/' }, version: { args: ['--eval', 'throw new Error("forbidden")'] } }],
    } }));
    const execute = vi.fn(async () => { throw new Error('Must not execute'); });
    const createRuntime = vi.fn(async () => { throw new Error('Must not activate'); });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const readConfiguration = () => ({ plugins: [
      { id: 'context.malicious', builtin: false },
      { id: 'host.ssh', builtin: true, config: { hosts: [{ alias: 'a', address: 'a' }], binary: '/custom/ssh' } },
    ] });
    try {
      for (const [id, reason] of [['context.malicious', 'not-approved'], ['host.ssh', 'custom-binding']]) {
        const program = new Command().exitOverride();
        registerPluginCommands(program, { homeDir, createRuntime, readConfiguration, toolDiagnostics: { execute, executorLifecycle: 'trusted-cooperative' } });
        await program.parseAsync(['node', 'afk', 'plugin', 'doctor', '--plugin', id, '--probe', '--json']);
        expect(JSON.parse(String(write.mock.calls.at(-1)![0])).externalTools).toContainEqual(expect.objectContaining({ reason }));
      }
      expect(execute).not.toHaveBeenCalled(); expect(createRuntime).not.toHaveBeenCalled();
    } finally { await rm(homeDir, { recursive: true, force: true }); }
  });
});

describe('proposed static manager CLI configuration wiring', () => {
  it('saves unresolved environment references through the real CLI and shared manager without activation', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'static-configure-cli-'));
    const file = join(homeDir, 'settings.json');
    await writeFile(file, JSON.stringify({ webhook: { env: 'D01_UNRESOLVED_REFERENCE' } }));
    const createRuntime = vi.fn(async () => { throw new Error('Configuration must not activate providers'); });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const program = new Command().exitOverride();
    registerPluginCommands(program, { homeDir, createRuntime });
    try {
      await program.parseAsync(['node', 'afk', 'plugin', 'configure', 'notification.slack', '--builtin', '--file', file]);
      expect(readPluginConfiguration(homeDir).plugins).toContainEqual(expect.objectContaining({ id: 'notification.slack', config: { webhook: { env: 'D01_UNRESOLVED_REFERENCE' } } }));
      await program.parseAsync(['node', 'afk', 'plugin', 'list', '--json']);
      const rows = JSON.parse(String(write.mock.calls.at(-1)![0]));
      expect(rows.find((row: { id: string }) => row.id === 'notification.slack').configuration).toBe('valid');
      expect(createRuntime).not.toHaveBeenCalled();
    } finally { write.mockRestore(); await rm(homeDir, { recursive: true, force: true }); }
  });
});

describe('whole doctor diagnosis deadline', () => {
  it('shares the configured budget across real Commander inventory rows without converting expiry to cancellation', async () => {
    const createRuntime = vi.fn(async () => { throw new Error('Doctor must stay passive'); });
    const execute = vi.fn((request: import('@afk/runtime/plugin-sdk').VersionProbeRequest) => new Promise<never>((_resolve, reject) => {
      request.signal.addEventListener('abort', () => setTimeout(() => reject(Object.assign(new Error('Cleanup unconfirmed'), { code: 'PROBE_CLEANUP_UNCONFIRMED' })), 5), { once: true });
    }));
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    const program = new Command().exitOverride();
    registerPluginCommands(program, { createRuntime, readConfiguration: () => ({ plugins: [] }),
      toolDiagnostics: { timeoutMs: 30, execute, executorLifecycle: 'trusted-cooperative' } });
    try {
      await program.parseAsync(['node', 'afk', 'plugin', 'doctor', '--probe', '--json']);
      const tools = JSON.parse(String(output.mock.calls[0][0])).externalTools as { pluginId: string; reason?: string; cleanup?: string }[];
      expect(execute).toHaveBeenCalledTimes(1);
      expect(tools).toContainEqual(expect.objectContaining({ pluginId: 'host.ssh', reason: 'timeout', cleanup: 'unconfirmed' }));
      for (const pluginId of ['host.aws-ssm', 'host.kubernetes-exec', 'sandbox.docker', 'sandbox.podman']) {
        expect(tools).toContainEqual(expect.objectContaining({ pluginId, reason: 'timeout' }));
      }
      expect(tools.some(tool => tool.reason === 'cancelled')).toBe(false);
      expect(tools).toContainEqual(expect.objectContaining({ pluginId: 'agent.codex', reason: 'backend-required' }));
      expect(createRuntime).not.toHaveBeenCalled();
    } finally { output.mockRestore(); process.exitCode = previousExitCode; }
  });
});
