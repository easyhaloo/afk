import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const artifacts = {
  arm64: '62f7f0fa89ac3292fe8388f0119818dcb5938550cdc04b283c81d72974d82478',
  x64: '9f38b1255dbc78a338af945b30a8a49a3cf93dadd44a3f98427f2ecc2c433806',
};
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');

export async function startInstalled({ installed, root, workspace, worktree, receipt }) {
  process.env.PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
  const run = (command, args) => execFileSync(command, args, { cwd: workspace, encoding: 'utf8', timeout: 45000 }).trim();
  const archive = join(installed, `afk-linux-${process.arch}.tar.gz`);
  const installer = join(installed, 'install.sh');
  assert.equal(digest(archive), artifacts[process.arch]);
  assert.equal(digest(installer), '8376c5273aaa2a08b3ca2027dcb7571ee30a2a806546976eacec0dd9ee646af9');
  run('bash', [installer, '--skip-completion', '--archive', archive, '--checksum', `${archive}.sha256`, '--version', '0.2.168']);
  const cli = join(process.env.HOME, '.local/bin/afk');
  assert.ok(realpathSync(cli).startsWith(`${process.env.HOME}/`));
  const version = run(cli, ['--version']);
  assert.equal(version, '0.2.168');
  Object.assign(receipt, { cli: version, archiveSha256: digest(archive), installerSha256: digest(installer),
    packageRun: '44595292353', entry: 'afk plugin serve-container --sandbox podman', node: process.version });
  run('git', ['init', '-q', workspace]);
  const directory = join(root, 'agent');
  mkdirSync(directory);
  const manifest = { id: 'w10.shell', version: '1.0.0', apiVersion: 1, provides: ['agent.provider'], trusted: true, entry: 'index.mjs' };
  writeFileSync(join(directory, 'plugin.json'), JSON.stringify(manifest));
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'w10-shell', version: '1.0.0', private: true }));
  writeFileSync(join(directory, 'index.mjs'), `export default { manifest: ${JSON.stringify(manifest)}, activate(context) {
    context.registerAgentProvider('w10-shell', { name: 'w10-shell', capabilities: new Set(), createExecution(options) {
      if (![1, 2].includes(options.generation)) throw new Error('Unknown workload');
      return options.sandbox.startAgent({ command: { argv: ['/bin/sh', '-e', 'w10-probe-' + options.generation] },
        generation: options.generation, prompt: options.prompt, signalType: 'goal_complete', metadata: { provider: 'w10-shell', transport: 'process' } });
    } });
  } };`);
  run(cli, ['plugin', 'install', directory]);
  run(cli, ['plugin', 'enable', 'w10.shell']);
  run(cli, ['plugin', 'enable', 'sandbox.podman']);
  const token = randomBytes(36).toString('hex');
  const server = spawn(cli, ['plugin', 'serve-container', '--repository', workspace, '--workspace-root', workspace,
    '--sandbox', 'podman', '--agent', 'w10-shell', '--port', '0', '--token-env', 'W10_TOKEN'], {
    cwd: workspace, env: { ...process.env, W10_TOKEN: token }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exit = once(server, 'close');
  let output = '';
  server.stdout.on('data', chunk => { output += chunk; });
  const dispose = async () => {
    server.kill('SIGTERM');
    const timeout = setTimeout(() => server.kill('SIGKILL'), 6000);
    try { await exit; } finally { clearTimeout(timeout); }
  };
  try {
    for (let attempt = 0; attempt < 150 && !output.includes('\n') && server.exitCode === null; attempt++) await delay(100);
    const address = /Remote container service ready at (127\.0\.0\.1:\d+)/.exec(output)?.[1];
    assert.ok(address, `Installed CLI failed to start (exit ${server.exitCode})`);
    const request = async (route, body, status = 200) => {
      const response = await fetch(`http://${address}/${route}`, { method: 'POST', body: JSON.stringify(body),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(45000) });
      const result = await response.json();
      assert.equal(response.status, status, `${route}: ${JSON.stringify(result)}`);
      return result;
    };
    return { dispose, async create() {
      const { id: sandboxId } = await request('sandbox.create', { worktreePath: worktree, session: 'qualification' });
      let closed = false;
      return { async startAgent({ generation, command, prompt }) {
        writeFileSync(join(worktree, `w10-probe-${generation}`), command.argv[2]);
        const { id: executionId } = await request('agent.start', { sandboxId, options: { generation, prompt,
          command: { argv: ['w10-shell'] }, signalType: 'goal_complete', metadata: { provider: 'w10-shell', transport: 'process' } } });
        return { waitForResult: options => request('agent.wait', { sandboxId, executionId, options }) };
      }, async close() {
        if (closed) return;
        assert.deepEqual(await request('sandbox.close', { sandboxId }), { ok: true });
        closed = true;
        const missing = await request('sandbox.close', { sandboxId }, 404);
        assert.equal(missing.error.code, 'SANDBOX_MISSING');
        receipt.afterCloseService = missing.error.code;
      } };
    } };
  } catch (error) { await dispose(); throw error; }
}
