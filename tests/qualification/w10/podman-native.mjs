import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
assert.equal(process.platform, 'linux', 'native local Podman needs Linux');
assert.notEqual(process.getuid(), 0, 'run the qualification as a rootless user');
const root = mkdtempSync('/tmp/afk-podman-');
const graph = join(root, 'graph');
const runroot = join(root, 'runroot');
const profile = join(root, 'home');
const workspace = join(root, 'workspace');
const worktree = join(workspace, 'checkout');
const runtimeDir = join(root, 'run');
const config = join(root, 'containers.conf');
const storage = join(root, 'storage.conf');
const command = (binary, args) => execFileSync(binary, args, { encoding: 'utf8', timeout: 30_000 }).trim();
const podman = (...args) => command('podman', args);
const inspect = (...args) => JSON.parse(podman(...args))[0];
const imageName = `localhost/afk-qualification:${randomUUID()}`;
const receipt = { provider: 'sandbox.podman', mode: 'workspace-build', commit: command('git', ['-C', repo, 'rev-parse', 'HEAD']),
  cli: JSON.parse(readFileSync(join(repo, 'apps/cli/package.json'))).version, runId: process.env.GITHUB_RUN_ID,
  attempt: process.env.GITHUB_RUN_ATTEMPT };

function importLinuxCommands() {
  const filesystem = join(root, 'rootfs');
  for (const directory of ['etc', 'tmp', 'dev', 'proc', 'sys', 'run']) mkdirSync(join(filesystem, directory), { recursive: true });
  const files = new Set(['/bin/sh', '/bin/sleep', '/usr/bin/id']);
  for (const binary of [...files]) {
    const libraries = command('ldd', [binary]);
    for (const [, path] of libraries.matchAll(/(\/[^\s()]+)\s+\(/g)) files.add(path);
  }
  for (const source of files) {
    const target = join(filesystem, source);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  const archive = join(root, 'rootfs.tar');
  command('tar', ['--owner=0', '--group=0', '-cf', archive, '-C', filesystem, '.']);
  podman('import', archive, imageName);
  return inspect('image', 'inspect', imageName).Id;
}

let runtime;
let sandbox;
let privateStore = false;
let imported = false;
try {
  for (const directory of [profile, runtimeDir, worktree]) mkdirSync(directory, { mode: 0o700, recursive: true });
  writeFileSync(storage, `[storage]\ndriver="vfs"\ngraphroot="${graph}"\nrunroot="${runroot}"\n`);
  writeFileSync(config, '[containers]\nnetns="none"\ncgroups="disabled"\n');
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, { HOME: profile, PATH: '/usr/bin:/bin', LANG: 'C', XDG_RUNTIME_DIR: runtimeDir,
    CONTAINERS_STORAGE_CONF: storage, CONTAINERS_CONF: config, PODMAN_USERNS: 'keep-id:uid=1000,gid=1000' });
  const version = podman('--version');
  assert.match(version, /^podman version \d/);
  const { host, store } = JSON.parse(podman('info', '--format', 'json'));
  assert.equal(host.os, 'linux');
  assert.equal(host.serviceIsRemote, false);
  assert.equal(host.security.rootless, true);
  assert.ok(host.ociRuntime.name);
  assert.equal(store.graphRoot, graph);
  assert.equal(store.runRoot, runroot);
  privateStore = true;
  receipt.engine = { version, arch: host.arch, oci: host.ociRuntime.name, local: true, rootless: true };
  receipt.image = importLinuxCommands();
  imported = true;
  process.env.AFK_SANDBOX_IMAGE = imageName;
  const { createConfiguredPlugins } = await import('../../../packages/runtime/dist/application/plugins/configured.js');
  const { PluginRuntime } = await import('../../../packages/runtime/dist/application/plugins/runtime.js');
  const { workspaceDataDirectory } = await import('../../../packages/runtime/dist/shared/workspace-paths.js');
  runtime = new PluginRuntime();
  const [plugin] = await createConfiguredPlugins({ configurations: [{ id: 'sandbox.podman', config: { engine: 'podman' } }] });
  await runtime.activate(plugin);
  const provider = runtime.getSandboxProvider('podman');
  assert.equal(provider?.name, 'podman');
  sandbox = await provider.create({ workspaceRoot: workspace, worktreePath: worktree, session: 'qualification', env: {} });
  const container = inspect('container', 'inspect', `afk-${sandbox.id.slice(0, 8)}`);
  assert.match(container.Id, /^[0-9a-f]{64}$/);
  assert.equal(container.State.Running, true);
  assert.equal(container.Image.replace(/^sha256:/, ''), receipt.image.replace(/^sha256:/, ''));
  const data = workspaceDataDirectory(worktree);
  const mounts = container.Mounts.map(mount => [mount.Source, mount.Destination, mount.Type, mount.RW]).sort();
  assert.deepEqual(mounts, [[workspace, '/workspace'], [join(data, 'session'), '/afk/session'],
    [join(data, 'result'), '/afk/result'], [data, data]].map(pair => [...pair, 'bind', true]).sort());
  receipt.container = container.Id;
  receipt.mounts = mounts.map(([source, destination]) => [source.replace(root, '$RUN'), destination.replace(root, '$RUN')]);
  const marker = randomUUID();
  writeFileSync(join(worktree, 'input'), `${marker}\n`);
  const run = async (generation, script) => {
    const execution = await sandbox.startAgent({ command: { argv: ['sh', '-ec', script] }, generation,
      prompt: `prompt-${marker}`, metadata: { provider: 'qualification-shell', transport: 'process' }, signalType: 'goal_complete' });
    return execution.waitForResult({ completionTimeoutMs: 10_000 });
  };
  const success = await run(1, `test "$(id -u):$(id -g)" = 1000:1000
    read -r prompt; read -r input < input; test "$prompt" = "prompt-$input"
    printf '%s' "$prompt" > returned; printf '{"type":"goal_complete","input":"%s"}\\n' "$input"`);
  assert.equal(success.status, 'completed', JSON.stringify(success));
  assert.equal(success.exitCode, 0);
  assert.deepEqual(success.structuredOutput, { type: 'goal_complete', input: marker });
  assert.equal(readFileSync(join(worktree, 'returned'), 'utf8'), `prompt-${marker}`);
  const failure = await run(2, `printf '%s' 'denied-${marker}' >&2; exit 23`);
  assert.equal(failure.status, 'failed');
  assert.equal(failure.exitCode, 23);
  assert.deepEqual(failure.error, { code: 'NON_ZERO_EXIT', message: `denied-${marker}` });
  receipt.commands = { uidGid: '1000:1000', success: success.exitCode, failure: failure.exitCode,
    error: failure.error.code, returnedSha256: createHash('sha256').update(`prompt-${marker}`).digest('hex') };
  await sandbox.close();
  const exists = spawnSync('podman', ['container', 'exists', container.Id], { timeout: 10_000 });
  assert.equal(exists.status, 1, exists.stderr?.toString());
  assert.equal(JSON.parse(podman('info', '--format', 'json')).store.graphRoot, graph);
  receipt.afterClose = { existsExit: exists.status, engineResponsive: true };
} finally {
  await sandbox?.close();
  await runtime?.dispose();
  if (privateStore) {
    assert.equal(podman('ps', '-aq'), '', `container still present in isolated store ${root}`);
    if (imported) podman('rmi', imageName);
    podman('system', 'migrate');
  }
  rmSync(root, { recursive: true, force: true });
}
console.log(`AFK_PODMAN_RECEIPT ${JSON.stringify(receipt)}`);
