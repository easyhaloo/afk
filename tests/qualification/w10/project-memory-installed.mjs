import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

assert.equal(process.argv.length, 3, 'usage: node project-memory-installed.mjs <installed-afk-entry>');
const entry = await realpath(process.argv[2]);
const runtimeRoot = join(dirname(dirname(entry)), 'node_modules/@afk/runtime/dist');
const runtime = join(runtimeRoot, 'infrastructure/providers/context.js');
const driver = fileURLToPath(new URL('./project-memory-workflow.mjs', import.meta.url));
const root = await realpath(await mkdtemp(join(tmpdir(), 'w10-project-memory-')));
const execute = promisify(execFile);
const env = { PATH: process.env.PATH, HOME: root, AFK_HOME: join(root, 'profile') };
const run = (...args) => execute(process.execPath, args, { cwd: root, env, timeout: 15000 });
const cli = (...args) => run(entry, ...args);
const provider = 'context.project-memory';
const file = join(root, 'project', 'memory.json');
const nonce = randomBytes(8).toString('hex');
const records = Array.from({ length: 12 }, (_, index) => ({ origin: `task-${index + 1}`, content: `handoff ${nonce} record ${index + 1}` }));
const sort = values => [...values].sort((left, right) => left.origin.localeCompare(right.origin));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const gather = async input => JSON.parse((await cli('plugin', 'invoke', 'context.provider', provider, 'gather', '--input', input, '--json')).stdout);

const workflow = async (id, expected) => {
  const workspace = join(root, `workflow-${id}`);
  await mkdir(workspace);
  const { stdout } = await execute(process.execPath, [driver, runtimeRoot, String(id), JSON.stringify(expected)], {
    cwd: workspace, env, timeout: 20000,
  });
  return JSON.parse(stdout.trim().split('\n').at(-1));
};

try {
  const version = (await cli('--version')).stdout.trim();
  await writeFile(join(root, 'config.json'), JSON.stringify({ file }));
  await writeFile(join(root, 'query.json'), JSON.stringify({ scope: '.', prompt: `handoff ${nonce}`, limit: records.length }));
  await writeFile(join(root, 'miss.json'), JSON.stringify({ scope: '.', prompt: 'no-match-cerulean' }));
  await cli('plugin', 'configure', provider, '--builtin', '--file', 'config.json');
  await cli('plugin', 'enable', provider);
  assert.deepEqual(await gather('query.json'), []);

  const write = `const { ProjectMemoryProvider } = await import(process.argv[1]);
    await new ProjectMemoryProvider({ file: process.argv[2] }).remember(JSON.parse(process.argv[3]));`;
  const writes = await Promise.allSettled(records.map(record =>
    run('--input-type=module', '-e', write, pathToFileURL(runtime).href, file, JSON.stringify(record))));
  assert.deepEqual(writes.flatMap(result => result.status === 'rejected' ? [String(result.reason)] : []), []);
  const bytes = await readFile(file);
  assert.deepEqual(sort(JSON.parse(bytes)), sort(records));
  const reads = await Promise.all([gather('query.json'), gather('query.json'), gather('miss.json')]);
  for (const result of reads.slice(0, 2)) {
    assert.deepEqual(sort(result.map(({ origin, content }) => ({ origin, content }))), sort(records));
  }
  assert.deepEqual(reads[2], []);
  const remainingFiles = await readdir(dirname(file));
  const mode = (await stat(file)).mode & 0o777;
  assert.deepEqual(remainingFiles, ['memory.json']);
  assert.equal(mode, 0o600);

  await appendFile(join(root, '.afk', 'plugins.yml'), `\nintegrations:
  contexts:
    - provider: ${provider}
      query: ${JSON.stringify({ scope: '.', prompt: `handoff ${nonce}`, limit: records.length })}
`);
  const workflows = await Promise.all([workflow(13, records), workflow(14, records)]);
  assert.notEqual(workflows[0].runId, workflows[1].runId);
  assert.notEqual(workflows[0].workItemId, workflows[1].workItemId);
  assert.equal(workflows[0].contextSha256, workflows[1].contextSha256);

  await cli('plugin', 'disable', provider);
  const disabled = await gather('query.json').then(() => null, error => ({ exit: error.code, diagnostic: error.stderr.trim() }));
  assert.deepEqual(disabled, { exit: 1, diagnostic: 'Capability provider is not registered' });
  const disabledWorkflow = await workflow(15, []);
  assert.deepEqual(await readFile(file), bytes);
  console.log(JSON.stringify({ version, platform: `${process.platform}-${process.arch}`, provider,
    runtimeSha256: digest(await readFile(runtime)), fileSha256: digest(bytes), writes: writes.length,
    reads: reads.map(value => value.length), initialRead: 0, remainingFiles, fileMode: `0${mode.toString(8)}`, disabled, workflows, disabledWorkflow }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
