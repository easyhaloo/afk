import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const binary = resolve('apps/cli/dist/index.js');
const fixtures = resolve('tests/fixtures/plugin-matrix/local');
const directories: string[] = [];
const secret = 'synthetic-matrix-credential-42';
const content = 'needle needle from the matrix\n';
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function sandbox(credential?: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'plugin-local-matrix-')));
  directories.push(root);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  const output = join(root, 'output');
  const bin = join(root, 'bin');
  await Promise.all([home, workspace, output, bin].map(directory => mkdir(directory)));
  const control = join(root, 'control.json');
  await writeFile(control, '{}');
  const environment: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_TERMINAL_PROMPT: '0',
    PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
    PLUGIN_MATRIX_SECRET: secret, PLUGIN_MATRIX_OUTPUT: output, PLUGIN_MATRIX_CONTROL: control,
    PLUGIN_MATRIX_CREDENTIAL: credential,
  };
  const commandSource = await readFile(join(fixtures, 'command.mjs'), 'utf8');
  for (const name of ['matrix-keychain', 'matrix-backend', 'matrix-sendmail', 'notify-send', 'osascript', 'powershell']) {
    const path = join(bin, name);
    await writeFile(path, `#!${process.execPath}\n${commandSource}`);
    await chmod(path, 0o700);
  }
  await writeFile(join(workspace, 'widget.ts'), content);
  await writeFile(join(workspace, 'clean.txt'), 'ordinary project material\n');
  await writeFile(join(workspace, 'memory.json'), JSON.stringify([{ origin: 'prior-run', content }]));
  await writeFile(join(root, 'outside.txt'), 'needle outside sentinel\n');
  let sequence = 0;
  const inputFile = async (value: unknown) => {
    const path = join(root, `input-${sequence++}.json`);
    await writeFile(path, JSON.stringify(value));
    return path;
  };
  const cli = (...args: string[]) => execute(process.execPath, [binary, 'plugin', ...args], {
    cwd: workspace, env: environment, timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  const configure = async (id: string, config: unknown) => cli('configure', id, '--builtin', '--file', await inputFile(config));
  const invoke = async (capability: string, provider: string, operation: string, input: unknown) =>
    cli('invoke', capability, provider, operation, '--input', await inputFile(input), '--json');
  const git = (...args: string[]) => execute('git', args, { cwd: workspace, env: environment, timeout: 10_000 });
  const initializeGit = async () => {
    await git('init', '--initial-branch=main');
    await git('add', '.');
    await git('-c', 'user.name=Matrix', '-c', 'user.email=matrix@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'matrix fixture');
    return (await git('rev-parse', 'HEAD')).stdout.trim();
  };
  const optionalFile = async (path: string) => readFile(path, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const effects = () => Promise.all([
    join(workspace, 'widget.ts'), join(workspace, 'clean.txt'), join(workspace, 'memory.json'), join(root, 'outside.txt'),
    ...['result.txt', 'commands.jsonl', 'credential-receipt.json', 'backend-snapshot.json', 'verification.json', 'message.eml', 'desktop.json'].map(name => join(output, name)),
  ].map(optionalFile));
  const calls = async () => (await optionalFile(join(output, 'commands.jsonl')) ?? '').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { role: string; args: string[]; input: string });
  if (credential) {
    const extension = join(root, 'credential-consumer');
    await mkdir(extension);
    const manifest = { id: 'context.matrix-credential-probe', version: '1.0.0', apiVersion: 1, provides: ['context.provider'], requires: ['credential.provider'], trusted: true, entry: 'index.js' };
    await writeFile(join(extension, 'package.json'), JSON.stringify({ name: 'matrix-credential-consumer', version: '1.0.0', type: 'module' }));
    await writeFile(join(extension, 'plugin.json'), JSON.stringify(manifest));
    await copyFile(join(fixtures, 'credential-consumer.mjs'), join(extension, 'index.js'));
    await cli('install', extension);
  }
  return { root, home, workspace, output, bin, environment, cli, configure, invoke, git, initializeGit, effects, calls, optionalFile,
    mode: (mode: string) => writeFile(control, JSON.stringify({ mode })),
    settings: () => readFile(join(home, '.afk', 'plugins.yml'), 'utf8'),
  };
}

type Sandbox = Awaited<ReturnType<typeof sandbox>>;

it.each([0o700, 0o500])('keeps built CLI inventory and doctor read-only with selected audit artifacts and home mode %s', async mode => {
  const test = await sandbox();
  const system = join(test.home, '.afk');
  const reports = join(system, 'reports');
  const settings = join(system, 'plugins.yml');
  await test.configure('artifact.test-report-local', { root: reports });
  await writeFile(settings, JSON.stringify({
    plugins: [{ id: 'artifact.test-report-local', builtin: true, config: { root: reports } }],
    integrations: { evidence: { provider: 'test-report-local' } },
  }));
  const before = (await readdir(test.home, { recursive: true })).sort();
  const configuration = await readFile(settings);
  await chmod(system, mode);
  await chmod(test.home, mode);
  try {
    const listed = JSON.parse((await test.cli('list', '--json')).stdout);
    expect(listed.some((plugin: { id: string }) => plugin.id === 'artifact.test-report-local')).toBe(true);
    const diagnosis = JSON.parse((await test.cli('doctor', '--plugin', 'artifact.test-report-local', '--json')).stdout);
    expect(diagnosis.health).toEqual([expect.objectContaining({ pluginId: 'artifact.test-report-local', status: 'degraded' })]);
    expect((await readdir(test.home, { recursive: true })).sort()).toEqual(before);
    expect(await readFile(settings)).toEqual(configuration);
    if (process.platform !== 'win32') {
      expect((await lstat(test.home)).mode & 0o777).toBe(mode);
      expect((await lstat(system)).mode & 0o777).toBe(mode);
    }
    expect(await test.calls()).toEqual([]);
  } finally {
    await chmod(test.home, 0o700);
    await chmod(system, 0o700);
  }
  const receipt = JSON.parse((await test.invoke('artifact.provider', 'test-report-local', 'put', {
    name: 'readiness-report.txt', mediaType: 'text/plain', bytes: Buffer.from(content).toString('base64'),
  })).stdout);
  expect(receipt.name).toBe('readiness-report.txt');
  expect(await readFile(join(reports, receipt.name), 'utf8')).toBe(content);
  expect(await test.optionalFile(join(system, 'evidence', 'encryption.key'))).toBeNull();
});
const verifyCommand = [process.execPath, '-e', 'require("node:fs").writeFileSync(process.env.PLUGIN_MATRIX_OUTPUT + "/verification.json", JSON.stringify({ cwd: process.cwd(), result: "verified" })); process.stdout.write("matrix verified");'];
const message = { title: 'Matrix "title"', body: 'body with $HOME; $(touch injected)\nnext line', urgency: 'high' };
const compliance = { rules: [
  { id: 'allow-publish', effect: 'allow', actions: ['publish'], when: { approved: true } },
  { id: 'deny-risk', effect: 'deny', actions: ['publish'], when: { risk: 'high' }, reason: 'review required' },
] };

const providers = [
  { id: 'context.code', capability: 'context.provider', provider: 'context.code', operation: 'gather', config: (test: Sandbox) => ({ root: test.workspace }), input: () => ({ scope: 'widget.ts', prompt: 'needle', limit: 1 }) },
  { id: 'context.retrieval', capability: 'context.provider', provider: 'context.retrieval', operation: 'gather', config: () => ({ documents: [{ origin: 'guide', content }, { origin: 'other', content: 'unrelated' }] }), input: () => ({ scope: '.', prompt: 'needle', limit: 1 }) },
  { id: 'context.project-memory', capability: 'context.provider', provider: 'context.project-memory', operation: 'gather', config: (test: Sandbox) => ({ file: join(test.workspace, 'memory.json') }), input: () => ({ scope: '.', prompt: 'needle', limit: 1 }) },
  ...['credential.enterprise', 'credential.system-keychain'].map(id => ({ id, capability: 'context.provider', provider: 'matrix-credential-probe', operation: 'gather', config: (test: Sandbox) => id === 'credential.enterprise' ? { values: { matrix: { env: 'PLUGIN_MATRIX_SECRET' } } } : { service: 'afk-matrix-only', command: join(test.bin, 'matrix-keychain') }, input: () => ({ scope: 'matrix', prompt: '' }) })),
  ...['test-report-local', 'evidence-bundle'].map(provider => ({ id: `artifact.${provider}`, capability: 'artifact.provider', provider, operation: 'put', config: (test: Sandbox) => ({ root: test.output }), input: () => ({ name: 'result.txt', mediaType: 'text/plain', bytes: Buffer.from(content).toString('base64') }) })),
  { id: 'repository.multi-repository', capability: 'repository.provider', provider: 'multi-repository', operation: 'snapshot', config: (test: Sandbox) => ({ repositories: [{ name: 'fixture', path: test.workspace }] }), input: () => ({ url: 'fixture' }) },
  { id: 'repository.special-git-backend', capability: 'repository.provider', provider: 'special-git-backend', operation: 'snapshot', config: (test: Sandbox) => ({ backend: join(test.bin, 'matrix-backend') }), input: (test: Sandbox) => ({ url: test.workspace }) },
  { id: 'policy.secret-scan', capability: 'policy.provider', provider: 'secret-scan', operation: 'evaluate', config: (test: Sandbox) => ({ root: test.workspace, files: ['clean.txt'] }), input: () => ({ action: 'publish' }) },
  { id: 'policy.license-policy', capability: 'policy.provider', provider: 'license-policy', operation: 'evaluate', config: () => ({ allowlist: ['MIT'], licenses: ['MIT'] }), input: () => ({ action: 'publish' }) },
  { id: 'policy.compliance-policy', capability: 'policy.provider', provider: 'compliance-policy', operation: 'evaluate', config: () => compliance, input: () => ({ action: 'publish', context: { approved: true } }) },
  ...['test-runner', 'static-scan', 'browser-check'].map(provider => ({ id: `verification.${provider}`, capability: 'verification.provider', provider, operation: 'verify', config: () => ({ command: verifyCommand }), input: (test: Sandbox) => ({ target: test.workspace }) })),
  { id: 'notification.email', capability: 'notification.provider', provider: 'notification.email', operation: 'notify', config: (test: Sandbox) => ({ from: 'sender@example.test', to: 'receiver@example.test', sendmailPath: join(test.bin, 'matrix-sendmail') }), input: () => message },
  { id: 'notification.desktop', capability: 'notification.provider', provider: 'notification.desktop', operation: 'notify', config: () => ({ platform: 'linux' }), input: () => message },
];
type Provider = typeof providers[number];

function spec(id: string): Provider {
  const provider = providers.find(candidate => candidate.id === id);
  if (!provider) throw new Error(`Missing matrix provider ${id}`);
  return provider;
}

async function configured(id: string) {
  const provider = spec(id);
  const test = await sandbox(id.startsWith('credential.') ? id : undefined);
  if (id.startsWith('repository.')) await test.initializeGit();
  expect((await test.configure(id, provider.config(test))).stdout).toBe(`Configured ${id}\n`);
  if (id === 'credential.system-keychain') await test.configure('credential.enterprise', spec('credential.enterprise').config(test));
  return { ...test, provider, run: (input: unknown = provider.input(test)) => test.invoke(provider.capability, provider.provider, provider.operation, input) };
}

async function expectRejected(operation: Promise<unknown>, error: string) {
  await expect(operation).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining(error) });
}

async function expectDecision(operation: Promise<unknown>, expected: object) {
  try {
    await operation;
    throw new Error('Expected a rejected CLI operation');
  } catch (error) {
    expect(error).toMatchObject({ code: 1 });
    expect(JSON.parse((error as { stdout: string }).stdout)).toMatchObject(expected);
  }
}

async function expectSuccess(test: Awaited<ReturnType<typeof configured>>) {
  const { provider } = test;
  const result = JSON.parse((await test.run()).stdout);
  if (provider.id.startsWith('credential.')) {
    expect(result).toEqual([{ origin: provider.id, content: digest(secret) }]);
    expect(JSON.parse(await readFile(join(test.output, 'credential-receipt.json'), 'utf8'))).toEqual({ provider: provider.id, digest: digest(secret), length: secret.length });
  } else if (provider.capability === 'context.provider') {
    const origin = provider.id === 'context.code' ? 'widget.ts' : provider.id === 'context.retrieval' ? 'guide' : 'prior-run';
    expect(result).toEqual([{ origin, content: provider.id === 'context.retrieval' ? content.trim() : content, score: 2 }]);
    expect(await readFile(join(test.workspace, 'widget.ts'), 'utf8')).toBe(content);
  } else if (provider.capability === 'artifact.provider') {
    expect(result).toEqual({ name: 'result.txt', uri: pathToFileURL(join(test.output, 'result.txt')).href });
    const stored = await readFile(join(test.output, 'result.txt'), 'utf8');
    if (provider.provider === 'test-report-local') expect(stored).toBe(content);
    else {
      const records = [{ id: 'result.txt', mediaType: 'text/plain', sha256: digest(content), size: Buffer.byteLength(content) }];
      expect(JSON.parse(stored)).toEqual({ version: 1, algorithm: 'sha256', recordCount: 1, totalBytes: Buffer.byteLength(content), bundleSha256: digest(JSON.stringify(records)), records });
      expect(stored).not.toContain(content.trim());
    }
  } else if (provider.capability === 'repository.provider') {
    expect(result).toEqual({ commit: (await test.git('rev-parse', 'HEAD')).stdout.trim(), branch: 'main', dirty: false });
    if (provider.provider === 'special-git-backend') expect(JSON.parse(await readFile(join(test.output, 'backend-snapshot.json'), 'utf8'))).toEqual(result);
  } else if (provider.capability === 'policy.provider') {
    expect(result).toEqual({ allowed: true, rule: provider.provider === 'license-policy' ? 'license-allowlist' : provider.provider === 'compliance-policy' ? 'allow-publish' : 'secret-scan' });
    expect(await readFile(join(test.workspace, 'clean.txt'), 'utf8')).toBe('ordinary project material\n');
  } else if (provider.capability === 'verification.provider') {
    expect(result).toEqual({ passed: true, durationMs: expect.any(Number), output: 'matrix verified' });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(await readFile(join(test.output, 'verification.json'), 'utf8'))).toEqual({ cwd: test.workspace, result: 'verified' });
  } else {
    const channel = provider.id === 'notification.email' ? 'email' : 'desktop';
    expect(result).toEqual({ delivered: true, channel });
    if (channel === 'email') {
      expect(await readFile(join(test.output, 'message.eml'), 'utf8')).toBe(`From: sender@example.test\r\nTo: receiver@example.test\r\nSubject: ${message.title}\r\nX-Urgency: high\r\n\r\n${message.body}`);
      expect((await test.calls()).at(-1)).toEqual({ role: 'matrix-sendmail', args: ['-t', '-oi', '-f', 'sender@example.test'], input: expect.stringContaining(message.body) });
    } else expect(JSON.parse(await readFile(join(test.output, 'desktop.json'), 'utf8'))).toEqual({ role: 'notify-send', args: ['-u', 'critical', message.title, message.body], input: '' });
    expect(await test.optionalFile(join(test.workspace, 'injected'))).toBeNull();
  }
}

describe('local plugin matrix: persisted lifecycle × public operation', () => {
  it.each(providers)('$id configure → invoke → disable → deny → reconfigure → enable → invoke', async provider => {
    const test = await configured(provider.id);
    await expectSuccess(test);
    const saved = await test.settings();
    await expectRejected(test.configure(provider.id, { unexpected: true }), 'Invalid plugin settings');
    expect(await test.settings()).toBe(saved);
    const effects = await test.effects();
    await expectRejected(test.run({ ...provider.input(test), unexpected: true }), 'Invalid or unsupported capability invocation');
    expect(await test.effects()).toEqual(effects);
    expect((await test.cli('disable', provider.id)).stdout).toBe(`Disabled ${provider.id}\n`);
    await expectRejected(test.run(), provider.id.startsWith('credential.') ? 'Matrix credential provider is not active' : 'Capability provider is not registered');
    expect(await test.effects()).toEqual(effects);
    expect(JSON.parse((await test.cli('list', '--json')).stdout).some((entry: { id: string }) => entry.id === provider.id)).toBe(false);
    await test.configure(provider.id, provider.config(test));
    await expectRejected(test.run(), provider.id.startsWith('credential.') ? 'Matrix credential provider is not active' : 'Capability provider is not registered');
    expect((await test.cli('enable', provider.id)).stdout).toBe(`Enabled ${provider.id}\n`);
    await expectSuccess(test);
    const inventory = await test.cli('list', '--json');
    expect(JSON.parse(inventory.stdout).some((entry: { id: string }) => entry.id === provider.id)).toBe(true);
    expect(inventory.stdout + await test.settings()).not.toContain(secret);
  }, 45_000);
});

describe('context selection and persisted memory', () => {
  it.each(['context.code', 'context.retrieval', 'context.project-memory'])('%s ranks matching fragments, filters misses, and enforces public limits', async id => {
    const test = await configured(id);
    const before = await test.effects();
    expect(JSON.parse((await test.run({ scope: '.', prompt: 'absentquery' })).stdout)).toEqual([]);
    for (const limit of [0, -1, 1.5]) await expectRejected(test.run({ scope: '.', prompt: 'needle', limit }), 'Invalid or unsupported capability invocation');
    await expectRejected(test.run({ scope: '.', prompt: 'needle', limit: 1001 }), 'Invalid context result limit');
    expect(await test.effects()).toEqual(before);
  });

  it('context.retrieval ranks ties by origin and applies the requested limit after filtering', async () => {
    const test = await configured('context.retrieval');
    const documents = [{ origin: 'z', content: 'needle' }, { origin: 'top', content: 'NEEDLE needle needle' }, { origin: 'a', content: 'needle' }, { origin: 'miss', content: 'ordinary' }];
    await test.configure(test.provider.id, { documents });
    expect(JSON.parse((await test.run({ scope: '.', prompt: 'needle NEEDLE', limit: 2 })).stdout)).toEqual([
      { origin: 'top', content: 'NEEDLE needle needle', score: 3 }, { origin: 'a', content: 'needle', score: 1 },
    ]);
    expect(JSON.parse((await test.run({ scope: '.', prompt: '' })).stdout)).toEqual([]);
    expect(await readFile(join(test.workspace, 'widget.ts'), 'utf8')).toBe(content);
  });

  it.each(['traversal', 'symlink', 'missing', 'oversized'])('context.code rejects %s without changing source files', async kind => {
    const test = await configured('context.code');
    let scope = '../outside.txt';
    let error = 'Context path escapes root';
    if (kind === 'symlink') {
      await symlink(join(test.root, 'outside.txt'), join(test.workspace, 'link.txt'));
      scope = 'link.txt'; error = 'symbolic link';
    } else if (kind === 'missing') {
      scope = 'missing.ts'; error = 'ENOENT';
    } else if (kind === 'oversized') {
      scope = 'large.ts'; error = 'byte limit';
      await writeFile(join(test.workspace, scope), 'needle'.repeat(200_000));
    }
    const before = await test.effects();
    await expectRejected(test.run({ scope, prompt: 'needle' }), error);
    expect(await test.effects()).toEqual(before);
  });

  it('context.code excludes generated directories, symlinks and binary content during traversal', async () => {
    const test = await configured('context.code');
    for (const name of ['node_modules', 'dist', 'build', '.git']) {
      await mkdir(join(test.workspace, name));
      await writeFile(join(test.workspace, name, 'hidden.ts'), 'needle hidden');
    }
    await writeFile(join(test.workspace, 'binary.ts'), 'needle\0binary');
    await symlink(join(test.root, 'outside.txt'), join(test.workspace, 'link.ts'));
    const fragments = JSON.parse((await test.run({ scope: '.', prompt: 'needle' })).stdout);
    expect(fragments.map((fragment: { origin: string }) => fragment.origin).sort()).toEqual(['memory.json', 'widget.ts']);
    expect(fragments.find((fragment: { origin: string }) => fragment.origin === 'widget.ts')).toEqual({ origin: 'widget.ts', content, score: 2 });
  });

  it.each([
    { name: 'malformed JSON', text: '{', error: 'Project memory is unreadable' },
    { name: 'non-array document', text: '{}', error: 'Invalid project memory document' },
    { name: 'invalid record', text: '[{"origin":"run","content":12}]', error: 'Invalid project memory record' },
  ])('context.project-memory rejects $name and preserves persisted bytes', async row => {
    const test = await configured('context.project-memory');
    const file = join(test.workspace, 'memory.json');
    await writeFile(file, row.text);
    await expectRejected(test.run(), row.error);
    expect(await readFile(file, 'utf8')).toBe(row.text);
  });

  it('context.project-memory returns empty for a missing file and reads later persisted updates in a new process', async () => {
    const test = await configured('context.project-memory');
    const file = join(test.workspace, 'memory.json');
    await rm(file);
    expect(JSON.parse((await test.run()).stdout)).toEqual([]);
    expect(await test.optionalFile(file)).toBeNull();
    const records = [{ origin: 'second-run', content: 'needle newest needle needle' }, { origin: 'first-run', content: 'needle' }];
    await writeFile(file, JSON.stringify(records));
    expect(JSON.parse((await test.run()).stdout)).toEqual([{ ...records[0], score: 3 }]);
    expect(await readFile(file, 'utf8')).toBe(JSON.stringify(records));
  });

  it('context.project-memory refuses a symlinked memory file', async () => {
    const test = await configured('context.project-memory');
    await rm(join(test.workspace, 'memory.json'));
    await symlink(join(test.root, 'outside.txt'), join(test.workspace, 'memory.json'));
    await expectRejected(test.run(), 'symbolic link');
    expect(await readFile(join(test.root, 'outside.txt'), 'utf8')).toBe('needle outside sentinel\n');
  });
});

describe('private credentials consumed by an installed local context plugin', () => {
  it.each(['credential.enterprise', 'credential.system-keychain'])('%s rejects public resolve and scoped consumption without emitting a secret', async id => {
    const test = await configured(id);
    const before = await test.effects();
    await expectRejected(test.invoke('credential.provider', id, 'resolve', { name: 'matrix' }), 'credential operations are private');
    expect(await test.effects()).toEqual(before);
    await expectRejected(test.run({ scope: 'matrix', prompt: 'publish' }), id === 'credential.enterprise' ? 'cannot issue scoped tokens' : 'do not support token scopes');
    expect(await test.effects()).toEqual(before);
    const inventory = await test.cli('list', '--json');
    expect(inventory.stdout + inventory.stderr + await test.settings()).not.toContain(secret);
  });

  it('credential.enterprise rejects a missing name and reads rotated environment values in fresh processes', async () => {
    const test = await configured('credential.enterprise');
    await expectRejected(test.run({ scope: 'missing', prompt: '' }), 'Environment credential is unavailable');
    expect(await test.optionalFile(join(test.output, 'credential-receipt.json'))).toBeNull();
    await expectSuccess(test);
    const rotated = 'synthetic-rotated-matrix-value';
    test.environment.PLUGIN_MATRIX_SECRET = rotated;
    expect(JSON.parse((await test.run()).stdout)).toEqual([{ origin: test.provider.id, content: digest(rotated) }]);
    expect(JSON.parse(await readFile(join(test.output, 'credential-receipt.json'), 'utf8'))).toEqual({ provider: test.provider.id, digest: digest(rotated), length: rotated.length });
    expect(await test.settings()).not.toContain(rotated);
  });

  it.each(['failure', 'empty'])('credential.system-keychain fails closed on mock command %s', async mode => {
    const test = await configured('credential.system-keychain');
    await test.mode(mode);
    await expectRejected(test.run(), 'System keychain credential is unavailable');
    expect(await test.optionalFile(join(test.output, 'credential-receipt.json'))).toBeNull();
    const args = process.platform === 'darwin' ? ['find-generic-password', '-s', 'afk-matrix-only', '-a', 'matrix', '-w'] : ['lookup', 'service', 'afk-matrix-only', 'account', 'matrix'];
    expect(await test.calls()).toEqual([{ role: 'matrix-keychain', args, input: '' }]);
    await test.mode('success');
    await expectSuccess(test);
  });

  it('credential references order keychain → enterprise → installed consumer and prevent disabling the dependency', async () => {
    const test = await configured('credential.enterprise');
    await test.configure('credential.system-keychain', spec('credential.system-keychain').config(test));
    await test.configure('credential.enterprise', { values: { matrix: { provider: 'credential.system-keychain', name: 'matrix' } } });
    await expectSuccess(test);
    await test.cli('disable', 'context.matrix-credential-probe');
    const settings = await test.settings();
    await expectRejected(test.cli('disable', 'credential.system-keychain'), 'credential.enterprise');
    expect(await test.settings()).toBe(settings);
    expect((await test.calls()).some(call => call.role === 'matrix-keychain')).toBe(true);
    await test.cli('enable', 'context.matrix-credential-probe');
    await test.mode('failure');
    const before = await readFile(join(test.output, 'credential-receipt.json'), 'utf8');
    await expectRejected(test.run(), 'Matrix credential provider is not active');
    expect(await readFile(join(test.output, 'credential-receipt.json'), 'utf8')).toBe(before);
  });
});

describe.each(['artifact.test-report-local', 'artifact.evidence-bundle'])('%s filesystem output boundary', id => {
  it.each(['traversal', 'symlink', 'non-directory-root', 'invalid-base64'])('rejects %s without replacing existing bytes', async kind => {
    const test = await configured(id);
    await expectSuccess(test);
    const input = test.provider.input(test) as { name: string; mediaType: string; bytes: string };
    let error = 'unsafe artifact name';
    if (kind === 'traversal') input.name = '../outside.txt';
    else if (kind === 'symlink') {
      await rm(join(test.output, 'result.txt'));
      await symlink(join(test.root, 'outside.txt'), join(test.output, 'result.txt'));
      error = 'symbolic link';
    } else if (kind === 'non-directory-root') {
      await test.configure(id, { root: join(test.workspace, 'clean.txt') });
      error = 'EEXIST';
    } else {
      input.bytes = 'not base64!';
      error = 'Invalid or unsupported capability invocation';
    }
    const before = await test.effects();
    await expectRejected(test.run(input), error);
    expect(await test.effects()).toEqual(before);
  });
});

describe('repository snapshots against real temporary Git data', () => {
  it('multi-repository resolves aliases and paths across two repositories and detects working tree changes', async () => {
    const test = await configured('repository.multi-repository');
    const second = join(test.root, 'second');
    await mkdir(second);
    const firstCommit = (await test.git('rev-parse', 'HEAD')).stdout.trim();
    await test.git('clone', '--no-hardlinks', '--', test.workspace, second);
    await test.git('-C', second, 'checkout', '-b', 'second-branch');
    await writeFile(join(second, 'widget.ts'), 'second repository change');
    await test.configure(test.provider.id, { repositories: [{ name: 'first', path: test.workspace }, { name: 'second', path: second }] });
    expect(JSON.parse((await test.run({ url: 'first' })).stdout)).toEqual({ commit: firstCommit, branch: 'main', dirty: false });
    for (const url of ['second', second]) expect(JSON.parse((await test.run({ url })).stdout)).toEqual({ commit: firstCommit, branch: 'second-branch', dirty: true });
    expect(await readFile(join(second, 'widget.ts'), 'utf8')).toBe('second repository change');
    expect(await readFile(join(test.workspace, 'widget.ts'), 'utf8')).toBe(content);
  });

  it.each(['unknown-repository', 'unsupported-ref', 'not-a-git-repository'])('multi-repository rejects %s', async kind => {
    const test = await configured('repository.multi-repository');
    let input: { url: string; ref?: string } = { url: 'unconfigured' };
    let error = 'repository is not configured';
    if (kind === 'unsupported-ref') { input = { url: 'fixture', ref: 'main' }; error = 'specific ref is not supported'; }
    if (kind === 'not-a-git-repository') {
      await test.configure(test.provider.id, { repositories: [{ name: 'fixture', path: test.output }] });
      input = { url: 'fixture' }; error = 'Provider command failed (128)';
    }
    const before = await test.effects();
    await expectRejected(test.run(input), error);
    expect(await test.effects()).toEqual(before);
  });

  it.each([
    // Backend stderr is deliberately redacted, so the exit code is not exposed.
    { mode: 'failure', error: 'special git backend snapshot command failed' },
    { mode: 'invalid-json', error: 'special git backend returned invalid JSON' },
    { mode: 'invalid-shape', error: 'repository snapshot is missing a commit' },
  ])('special-git-backend rejects $mode rather than fabricating a snapshot', async row => {
    const test = await configured('repository.special-git-backend');
    await test.mode(row.mode);
    await expectRejected(test.run(), row.error);
    expect(await test.optionalFile(join(test.output, 'backend-snapshot.json'))).toBeNull();
    expect(await test.calls()).toEqual([{ role: 'matrix-backend', args: ['snapshot', '--json', test.workspace], input: '' }]);
    expect(await readFile(join(test.workspace, 'widget.ts'), 'utf8')).toBe(content);
  });

  it.each([{ url: '--help' }, { url: 'fixture', ref: '--help' }])('special-git-backend rejects option injection $url $ref before execution', async input => {
    const test = await configured('repository.special-git-backend');
    await expectRejected(test.run(input), 'invalid backend repository');
    expect(await test.calls()).toEqual([]);
  });

  it('special-git-backend passes a ref as typed argv and returns its actual commit', async () => {
    const test = await configured('repository.special-git-backend');
    const expected = (await test.git('rev-parse', 'HEAD')).stdout.trim();
    const result = JSON.parse((await test.run({ url: test.workspace, ref: 'main' })).stdout);
    expect(result).toEqual({ commit: expected, branch: 'main', dirty: false });
    expect(await test.calls()).toEqual([{ role: 'matrix-backend', args: ['snapshot', '--json', test.workspace, '--ref', 'main'], input: '' }]);
    expect(JSON.parse(await readFile(join(test.output, 'backend-snapshot.json'), 'utf8'))).toEqual(result);
  });
});

describe('local policy decision matrix', () => {
  it.each([
    { name: 'OR permits the allowed alternative', license: 'MIT OR GPL-3.0', allowed: true },
    { name: 'AND requires both terms', license: 'MIT AND GPL-3.0', allowed: false },
    { name: 'comparison is case insensitive', license: 'mit', allowed: true },
    { name: 'parentheses preserve precedence', license: '(MIT OR GPL-3.0) AND MIT', allowed: true },
    { name: 'unlisted license denies', license: 'GPL-3.0', allowed: false },
    { name: 'unsupported exception fails closed', license: 'MIT WITH custom-exception', allowed: false },
    { name: 'malformed expression fails closed', license: '(MIT', allowed: false },
  ])('license-policy $name', async row => {
    const test = await configured('policy.license-policy');
    const input = { action: 'publish', context: { license: row.license } };
    const before = await test.effects();
    if (row.allowed) expect(JSON.parse((await test.run(input)).stdout)).toEqual({ allowed: true, rule: 'license-allowlist' });
    else await expectDecision(test.run(input), { allowed: false, rule: 'license-allowlist', reason: expect.any(String) });
    expect(await test.effects()).toEqual(before);
  });

  it('license-policy denies when neither configuration nor input supplies a license', async () => {
    const test = await configured('policy.license-policy');
    await test.configure(test.provider.id, { allowlist: ['MIT'] });
    await expectDecision(test.run(), { allowed: false, rule: 'license-allowlist', reason: 'no package license supplied' });
  });

  it.each([
    { name: 'matching allow', action: 'publish', context: { approved: true, risk: 'low' }, allowed: true, rule: 'allow-publish' },
    { name: 'deny overrides earlier allow', action: 'publish', context: { approved: true, risk: 'high' }, allowed: false, rule: 'deny-risk' },
    { name: 'predicate mismatch', action: 'publish', context: { approved: false }, allowed: false, rule: 'default-deny' },
    { name: 'unknown action', action: 'delete', context: { approved: true }, allowed: false, rule: 'default-deny' },
  ])('compliance-policy $name', async row => {
    const test = await configured('policy.compliance-policy');
    const before = await test.effects();
    const input = { action: row.action, context: row.context };
    if (row.allowed) expect(JSON.parse((await test.run(input)).stdout)).toMatchObject({ allowed: true, rule: row.rule });
    else await expectDecision(test.run(input), { allowed: false, rule: row.rule, reason: expect.any(String) });
    expect(await test.effects()).toEqual(before);
  });

  it('compliance-policy supports an explicit default allow without overriding a deny rule', async () => {
    const test = await configured('policy.compliance-policy');
    await test.configure(test.provider.id, { ...compliance, defaultEffect: 'allow' });
    expect(JSON.parse((await test.run({ action: 'read' })).stdout)).toEqual({ allowed: true, rule: 'default' });
    await expectDecision(test.run({ action: 'publish', context: { risk: 'high' } }), { allowed: false, rule: 'deny-risk', reason: 'review required' });
  });

  it.each([
    { kind: 'credential-assignment', text: 'password = synthetic-password-42' },
    { kind: 'github-token', text: `ghp_${'x'.repeat(30)}` },
    { kind: 'aws-access-key', text: `AKIA${'X'.repeat(16)}` },
    { kind: 'private-key', text: '-----BEGIN PRIVATE KEY-----' },
  ])('secret-scan denies $kind without returning matched text', async row => {
    const test = await configured('policy.secret-scan');
    await writeFile(join(test.workspace, 'clean.txt'), row.text);
    try {
      await test.run();
      throw new Error('Expected a policy denial');
    } catch (error) {
      expect(error).toMatchObject({ code: 1 });
      const result = error as { stdout: string; stderr: string };
      expect(JSON.parse(result.stdout)).toEqual({ allowed: false, rule: 'secret-scan', reason: `potential secret(s) detected in 1 file(s): ${row.kind}` });
      expect(result.stdout + result.stderr).not.toContain(row.text);
    }
    expect(await readFile(join(test.workspace, 'clean.txt'), 'utf8')).toBe(row.text);
  });

  it.each(['size-limit', 'symlink', 'traversal', 'missing-file'])('secret-scan fails closed for %s', async kind => {
    const test = await configured('policy.secret-scan');
    let error = 'refusing to scan symbolic link';
    if (kind === 'size-limit') await test.configure(test.provider.id, { root: test.workspace, files: ['clean.txt'], maxFileBytes: 4 });
    else if (kind === 'symlink') {
      await rm(join(test.workspace, 'clean.txt'));
      await symlink(join(test.root, 'outside.txt'), join(test.workspace, 'clean.txt'));
    } else if (kind === 'traversal') {
      await test.configure(test.provider.id, { root: test.workspace, files: ['../outside.txt'] });
      error = 'path escapes the scan root';
    } else {
      await rm(join(test.workspace, 'clean.txt'));
      error = 'ENOENT';
    }
    const before = await test.effects();
    if (kind === 'size-limit') await expectDecision(test.run(), { allowed: false, rule: 'secret-scan-incomplete', reason: 'secret scan exceeded maxFileBytes; review is incomplete' });
    else await expectRejected(test.run(), error);
    expect(await test.effects()).toEqual(before);
  });
});

describe.each(['verification.test-runner', 'verification.static-scan', 'verification.browser-check'])('%s command execution', id => {
  it.each(['nonzero', 'timeout', 'missing-command', 'invalid-argv'])('propagates %s and preserves actual command evidence', async kind => {
    const test = await configured(id);
    if (kind === 'invalid-argv') {
      const before = await test.effects();
      for (const command of [[], [''], [process.execPath, '\0']]) await expectRejected(test.run({ target: test.workspace, command }), 'Invalid or unsupported capability invocation');
      expect(await test.effects()).toEqual(before);
    } else if (kind === 'missing-command') {
      await expectRejected(test.run({ target: test.workspace, command: [join(test.root, 'missing-executable')] }), 'ENOENT');
      expect(await test.optionalFile(join(test.output, 'verification.json'))).toBeNull();
    } else {
      const script = 'require("node:fs").writeFileSync(process.env.PLUGIN_MATRIX_OUTPUT + "/verification.json", "started"); process.stdout.write("actual command output"); ' +
        (kind === 'nonzero' ? 'process.stderr.write("actual failure detail"); process.exit(7);' : 'setInterval(() => {}, 1000);');
      await expectDecision(test.run({ target: test.workspace, command: [process.execPath, '-e', script], timeoutMs: 2000 }), {
        passed: false, durationMs: expect.any(Number), output: expect.stringContaining(kind === 'nonzero' ? 'actual failure detail' : 'verification terminated'),
      });
      expect(await readFile(join(test.output, 'verification.json'), 'utf8')).toBe('started');
    }
  });

  it('request argv overrides configured command, preserves literal arguments and selects cwd', async () => {
    const test = await configured(id);
    const argument = 'literal $(touch injected); $HOME';
    const command = [process.execPath, '-e', 'require("node:fs").writeFileSync("override.txt", process.argv[1]); process.stdout.write(process.cwd());', argument];
    const result = JSON.parse((await test.run({ target: test.workspace, command })).stdout);
    expect(result).toMatchObject({ passed: true, output: test.workspace });
    expect(await readFile(join(test.workspace, 'override.txt'), 'utf8')).toBe(argument);
    expect(await test.optionalFile(join(test.workspace, 'injected'))).toBeNull();
    expect(await test.optionalFile(join(test.output, 'verification.json'))).toBeNull();
  });
});

describe('notification commands are confined to local delivery files', () => {
  it('email rejects CRLF header injection before launching sendmail', async () => {
    const test = await configured('notification.email');
    await expectDecision(test.run({ ...message, title: 'subject\r\nBcc: attacker@example.test' }), { delivered: false, channel: 'email', error: expect.stringContaining('Invalid Subject header') });
    expect(await test.calls()).toEqual([]);
    expect(await test.optionalFile(join(test.output, 'message.eml'))).toBeNull();
  });

  it('email failure returns a failed receipt, writes no mail, and recovers using the same configuration', async () => {
    const test = await configured('notification.email');
    await test.mode('failure');
    await expectDecision(test.run(), { delivered: false, channel: 'email', error: expect.any(String) });
    expect(await test.optionalFile(join(test.output, 'message.eml'))).toBeNull();
    expect(await test.calls()).toEqual([{ role: 'matrix-sendmail', args: ['-t', '-oi', '-f', 'sender@example.test'], input: expect.stringContaining(message.body) }]);
    await test.mode('success');
    await expectSuccess(test);
  });

  it.each([
    { platform: 'linux', role: 'notify-send', args: ['-u', 'critical', message.title, message.body], input: '' },
    { platform: 'darwin', role: 'osascript', args: ['-e', `display notification "${message.body}" with title "Matrix \\"title\\""`], input: '' },
    { platform: 'win32', role: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', '-'], input: `Add-Type -AssemblyName System.Windows.Forms\n[System.Windows.Forms.MessageBox]::Show('${message.body}', '${message.title}')` },
  ])('desktop $platform delivers literal content to a mock executable and reports command failure', async row => {
    const test = await configured('notification.desktop');
    await test.configure(test.provider.id, { platform: row.platform, channel: 'matrix-desktop' });
    expect(JSON.parse((await test.run()).stdout)).toEqual({ delivered: true, channel: 'matrix-desktop' });
    const receipt = await readFile(join(test.output, 'desktop.json'), 'utf8');
    expect(JSON.parse(receipt)).toEqual({ role: row.role, args: row.args, input: row.input });
    expect(await test.optionalFile(join(test.workspace, 'injected'))).toBeNull();
    await test.mode('failure');
    await expectDecision(test.run(), { delivered: false, channel: 'matrix-desktop', error: expect.any(String) });
    expect(await readFile(join(test.output, 'desktop.json'), 'utf8')).toBe(receipt);
    expect(await test.calls()).toHaveLength(2);
  });
});

it('cross-validates context → verification → report → evidence digests with policy and Git state through separate CLI processes', async () => {
  const test = await configured('verification.test-runner');
  const head = await test.initializeGit();
  for (const id of ['context.code', 'context.project-memory', 'artifact.test-report-local', 'artifact.evidence-bundle', 'repository.multi-repository', 'policy.secret-scan', 'policy.license-policy', 'policy.compliance-policy']) {
    await test.configure(id, spec(id).config(test));
  }
  await expectSuccess(test);
  const report = await readFile(join(test.output, 'verification.json'));
  for (const provider of ['test-report-local', 'evidence-bundle']) {
    const name = provider === 'test-report-local' ? 'verification-report.json' : 'verification-evidence.json';
    const ref = JSON.parse((await test.invoke('artifact.provider', provider, 'put', { name, mediaType: 'application/json', bytes: report.toString('base64') })).stdout);
    expect(ref).toEqual({ name, uri: pathToFileURL(join(test.output, name)).href });
  }
  expect(await readFile(join(test.output, 'verification-report.json'))).toEqual(report);
  const bundle = JSON.parse(await readFile(join(test.output, 'verification-evidence.json'), 'utf8'));
  expect(bundle.records).toEqual([{ id: 'verification-evidence.json', mediaType: 'application/json', size: report.length, sha256: digest(report) }]);
  expect(bundle.bundleSha256).toBe(digest(JSON.stringify(bundle.records)));
  const records = [{ origin: 'verified-run', content: `needle verified ${digest(report)}` }];
  await writeFile(join(test.workspace, 'memory.json'), JSON.stringify(records));
  expect(JSON.parse((await test.invoke('context.provider', 'context.project-memory', 'gather', { scope: '.', prompt: 'verified' })).stdout)).toEqual([{ ...records[0], score: 1 }]);
  expect(JSON.parse((await test.invoke('context.provider', 'context.code', 'gather', { scope: 'widget.ts', prompt: 'needle' })).stdout)).toEqual([{ origin: 'widget.ts', content, score: 2 }]);
  expect(JSON.parse((await test.invoke('repository.provider', 'multi-repository', 'snapshot', { url: 'fixture' })).stdout)).toEqual({ commit: head, branch: 'main', dirty: true });
  for (const provider of ['secret-scan', 'license-policy', 'compliance-policy']) {
    expect(JSON.parse((await test.invoke('policy.provider', provider, 'evaluate', { action: 'publish', context: { approved: true } })).stdout).allowed).toBe(true);
  }
  await writeFile(join(test.workspace, 'clean.txt'), 'password = synthetic-blocked-publication');
  await expectDecision(test.invoke('policy.provider', 'secret-scan', 'evaluate', { action: 'publish' }), { allowed: false, rule: 'secret-scan' });
  expect(await readFile(join(test.output, 'verification-report.json'))).toEqual(report);
}, 45_000);
