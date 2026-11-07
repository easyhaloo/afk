import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const execute = promisify(execFile);
const binary = resolve('apps/cli/dist/index.js');
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

it('installs and consumes local capabilities through the built CLI in isolated processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-local-e2e-'));
  directories.push(root);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await mkdir(home);
  await mkdir(workspace);
  let sequence = 0;
  const cli = async (...args: string[]) => execute(process.execPath, [binary, 'plugin', ...args], {
    cwd: workspace, env: { ...process.env, HOME: home, USERPROFILE: home, PLUGIN_LOCAL_E2E_HOOK: 'https://webhook.example.test/local-e2e' }, timeout: 15_000,
  });
  const inputFile = async (input: unknown) => {
    const path = join(root, `input-${sequence++}.json`);
    await writeFile(path, JSON.stringify(input));
    return path;
  };
  const configure = async (id: string, config: unknown) => cli('configure', id, '--builtin', '--file', await inputFile(config));
  const invoke = async (capability: string, provider: string, operation: string, input: unknown) => {
    const result = await cli('invoke', capability, provider, operation, '--input', await inputFile(input), '--json');
    return JSON.parse(result.stdout);
  };

  const extension = join(root, 'extension');
  await mkdir(extension);
  const manifest = { id: 'context.local-e2e', version: '1.0.0', apiVersion: 1, provides: ['context.provider'], trusted: true, entry: 'index.js' };
  await writeFile(join(extension, 'package.json'), JSON.stringify({ name: 'context-local-e2e', version: '1.0.0', type: 'module' }));
  await writeFile(join(extension, 'plugin.json'), JSON.stringify(manifest));
  await writeFile(join(extension, 'index.js'), `export default { manifest: ${JSON.stringify(manifest)}, activate(context) { context.registerContextProvider('local-e2e', { id: 'local-e2e', capabilities: { 'read-only': true, summarize: false, search: false }, async gather() { return [{ content: 'installed extension active', origin: 'local-e2e' }]; } }); } };`);
  await cli('install', extension);
  expect(await invoke('context.provider', 'local-e2e', 'gather', { scope: '.', prompt: '' })).toEqual([{ content: 'installed extension active', origin: 'local-e2e' }]);
  await cli('disable', manifest.id);
  await expect(invoke('context.provider', 'local-e2e', 'gather', { scope: '.', prompt: '' })).rejects.toThrow();
  await cli('enable', manifest.id);
  expect(await invoke('context.provider', 'local-e2e', 'gather', { scope: '.', prompt: '' })).toHaveLength(1);
  await cli('remove', manifest.id);
  await expect(readFile(join(home, '.afk', 'plugins', manifest.id, 'install.json'))).rejects.toMatchObject({ code: 'ENOENT' });

  await writeFile(join(workspace, 'widget.ts'), 'export const widget = 42;');
  await configure('context.code', { root: workspace });
  const context = await invoke('context.provider', 'context.code', 'gather', { scope: '.', prompt: 'widget' });
  expect(context.some((fragment: { content: string }) => fragment.content.includes('widget = 42'))).toBe(true);

  const reports = join(root, 'reports');
  await configure('artifact.test-report-local', { root: reports });
  const content = 'real local report';
  expect(await invoke('artifact.provider', 'test-report-local', 'put', { name: 'result.txt', mediaType: 'text/plain', bytes: Buffer.from(content).toString('base64') })).toMatchObject({ name: 'result.txt' });
  expect(await readFile(join(reports, 'result.txt'), 'utf8')).toBe(content);

  await configure('credential.enterprise', { values: { webhook: { env: 'PLUGIN_LOCAL_E2E_HOOK' } } });
  await configure('notification.slack', { webhook: { provider: 'credential.enterprise', name: 'webhook' } });
  await expect(cli('disable', 'credential.enterprise')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('notification.slack') });
  await expect(invoke('credential.provider', 'credential.enterprise', 'resolve', { name: 'webhook' })).rejects.toMatchObject({ code: 1 });
  await cli('disable', 'notification.slack');
  await cli('disable', 'credential.enterprise');
  await cli('enable', 'credential.enterprise');
  await cli('enable', 'notification.slack');
  const inventory = await cli('list', '--json');
  expect(inventory.stdout).toContain('notification.slack');
  expect(inventory.stdout).not.toContain('https://webhook.example.test/local-e2e');

  await configure('verification.test-runner', { command: [process.execPath, '-e', 'process.stdout.write("local check passed")'] });
  expect(await invoke('verification.provider', 'test-runner', 'verify', { target: workspace })).toMatchObject({ passed: true, output: expect.stringContaining('local check passed') });
  await configure('verification.test-runner', { command: [process.execPath, '-e', 'process.exit(7)'] });
  await expect(invoke('verification.provider', 'test-runner', 'verify', { target: workspace })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('"passed": false') });

  await configure('policy.license-policy', { allowlist: ['MIT'], licenses: ['GPL-3.0'] });
  await expect(invoke('policy.provider', 'license-policy', 'evaluate', { action: 'publish' })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('"allowed": false') });

  await execute('git', ['init', '--initial-branch=main', workspace]);
  await execute('git', ['add', 'widget.ts'], { cwd: workspace });
  await execute('git', ['-c', 'user.name=Plugin E2E', '-c', 'user.email=plugin-e2e@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'], { cwd: workspace });
  await configure('repository.multi-repository', { repositories: [{ name: 'fixture', path: workspace }] });
  const snapshot = await invoke('repository.provider', 'multi-repository', 'snapshot', { url: 'fixture' });
  expect(snapshot).toMatchObject({ branch: 'main', dirty: false });
  expect(snapshot.commit).toMatch(/^[a-f0-9]{40,64}$/);
}, 60_000);
