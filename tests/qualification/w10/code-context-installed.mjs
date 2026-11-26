import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [archiveArg, checksumArg, installerArg] = process.argv.slice(2);
const [archive, checksum, installer] = await Promise.all([archiveArg, checksumArg, installerArg].map(path => realpath(path)));
const root = await realpath(await mkdtemp(join(tmpdir(), 'w10-code-context-')));
const checkout = join(root, 'source');
const profile = join(root, 'profile');
try {
  await mkdir(checkout);
  await mkdir(join(root, '.afk'));
  const env = { PATH: process.env.PATH, HOME: root, AFK_HOME: profile, AFK_WORKSPACE_ROOT: join(root, 'workspaces') };
  const execute = (program, args, cwd = checkout) => execFileSync(program, args, { cwd, env, encoding: 'utf8', timeout: 25000 });
  execute('bash', [installer, '--skip-completion', '--archive', archive, '--checksum', checksum, '--version', '0.2.224']);
  const executable = join(root, '.local', 'bin', 'afk');
  const entry = await realpath(executable);
  const runtime = join(dirname(dirname(entry)), 'node_modules', '@afk', 'runtime', 'dist');
  const cli = (...args) => execute(executable, args);
  const version = cli('--version').trim();
  assert.equal(version, '0.2.224');
  const query = { scope: 'widget.ts', prompt: 'widget', limit: 1 };
  const record = label => ({ origin: 'widget.ts', content: `export const widget = "${label}";` });
  await writeFile(join(checkout, 'widget.ts'), record('source').content);
  execute('git', ['init', '-b', 'main']);
  execute('git', ['add', 'widget.ts']);
  execute('git', ['-c', 'user.name=AFK qualification', '-c', 'user.email=qualification@example.invalid', 'commit', '-m', 'Checkout baseline']);
  await writeFile(join(checkout, 'query.json'), JSON.stringify(query));
  const invoke = () => JSON.parse(cli('plugin', 'invoke', 'context.provider', 'context.code', 'gather', '--input', 'query.json', '--json'));
  assert.deepEqual(invoke(), [{ ...record('source'), score: 1 }]);
  const config = join(root, '.afk', 'plugins.yml');
  const integrations = { contexts: [{ provider: 'context.code', query }] };
  const profileFor = plugins => writeFile(config, JSON.stringify({ plugins, integrations }));
  const run = async (id, records) => {
    const cwd = join(root, `run-${id}`);
    await mkdir(cwd);
    const workflow = fileURLToPath(new URL('code-context-workflow.mjs', import.meta.url));
    return JSON.parse(execute(process.execPath, [workflow, runtime, String(id), JSON.stringify(records)], cwd).trim().split('\n').at(-1));
  };
  await profileFor([]);
  const defaults = await Promise.all([run(21, [record('execution-21')]), run(22, [record('execution-22')])]);
  assert.notEqual(defaults[0].contextSha256, defaults[1].contextSha256);
  await profileFor([{ id: 'context.code', builtin: true, config: { root: '.' } }]);
  const fixed = await run(23, [record('source')]);
  await profileFor([{ id: 'context.code', builtin: true, enabled: false }]);
  const disabled = await run(24, []);
  assert.throws(invoke, /Capability provider is not registered/);
  console.log(JSON.stringify({ version, platform: `${process.platform}-${process.arch}`,
    archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'), standalone: 'source', defaults, fixed, disabled }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
