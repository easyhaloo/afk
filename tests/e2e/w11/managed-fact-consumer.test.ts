import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { driver, grade, verifyManagedFact } from './managed-fact.js';
import { recallCases } from './recall-v1.js';

const execute = promisify(execFile);
const fact = recallCases.find(entry => entry.id === 'fact-01')!;
const paraphrase = recallCases.find(entry => entry.id === 'fact-02')!;
const otherProject = recallCases.find(entry => entry.id === 'fact-03')!;
const wrongVersion = recallCases.find(entry => entry.id === 'fact-04')!;
const fixturePath = process.env.AFK_W11_FACT01_FIXTURE;

it.each([{ answer: '封签后可以直接改址。' }, { source: 'wiki:seal-cutoff' }, { productVersion: '1.0' }])(
  'rejects an independent answer with %j', mismatch => {
    expect(() => grade({ answer: fact.asset.source, source: 'knowledge:test-key; target:wiki:seal-cutoff',
      productVersion: '2.0', ...mismatch }, 'test-key')).toThrow();
  });

const consumerCases = [[fact, '43'], [paraphrase, '45'], [otherProject, '46'], [wrongVersion, '44']] as const;
for (const [entryCase, itemId] of consumerCases) it.skipIf(!fixturePath)(`answers frozen ${entryCase.id} through a fresh managed OpenCode workflow`, async context => {
  expect(isAbsolute(fixturePath!)).toBe(true);
  const original = await realpath(fixturePath!);
  const userHome = userInfo().homedir;
  expect(original).not.toBe(await realpath(userHome));
  const entry = process.env.AFK_W11_CONSUMER_CLI_ENTRY ?? process.env.AFK_E2E_CLI_ENTRY;
  if (!entry || !isAbsolute(entry)) throw new Error('Set AFK_W11_CONSUMER_CLI_ENTRY to the absolute installed AFK entry');
  const binary = await realpath(entry);
  const release = dirname(dirname(binary));
  const runtime = await realpath(join(release, 'node_modules/@afk/runtime/dist'));
  expect(binary.startsWith(await realpath(fileURLToPath(new URL('../../../', import.meta.url))) + sep)).toBe(false);
  expect(binary).toBe(join(release, 'dist/index.js'));
  expect(runtime.startsWith(release + sep)).toBe(true);
  const runDirectory = await realpath(await mkdtemp(join(tmpdir(), 'w11-managed-fact-')));
  const fixture = join(runDirectory, 'profile');
  await mkdir(join(fixture, '.afk'), { recursive: true });
  try { await lstat(join(original, '.afk/learning/candidates.sqlite')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return context.skip();
    throw error;
  }
  for (const file of ['events', '.afk/plugins', '.afk/plugins.yml', '.afk/learning', 'distiller.json']) {
    await cp(join(original, file), join(fixture, file), { recursive: true });
  }
  const env = { ...process.env, HOME: fixture, USERPROFILE: fixture, AFK_EVENT_STORE_DIR: join(fixture, 'events') };
  const manifest = JSON.parse(await readFile(join(release, 'release.json'), 'utf8'));
  expect((await execute(process.execPath, [binary, '--version'], { env })).stdout.trim()).toBe(manifest.version);
  const gate = await execute(process.execPath, [driver, 'gate', runtime, fixture, binary, JSON.stringify(fact)], { env });
  const receipt = JSON.parse(gate.stdout);
  if (!receipt) {
    console.info('No matching real, validated, published fact-01 candidate in the supplied fixture');
    return context.skip();
  }
  const negative = entryCase.expected === 'exclude';
  const scope = entryCase.query.scope;
  const version = entryCase.query.target!.productVersions!.parcel;
  if (negative) {
    const configFile = join(fixture, 'distiller.json');
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    const contexts = config.executionContexts.filter((entry: { target: { project: string } }) => entry.target.project === fact.asset.scope);
    expect(contexts).toHaveLength(1);
    const [trusted] = contexts;
    expect(trusted).toMatchObject({ applicability: { environment: 'staging', version: '2.0' }, target: { productVersions: { parcel: '2.0' } } });
    trusted.applicability.version = version;
    trusted.target.project = scope;
    trusted.target.productVersions.parcel = version;
    await writeFile(configFile, JSON.stringify(config));
    await execute(process.execPath, [binary, 'plugin', 'configure', 'learning.distiller', '--builtin', '--file', configFile], { env, cwd: fixture });
  }
  await verifyManagedFact({ binary, runtime, fixture, runDirectory, itemId, cliVersion: manifest.version, entryCase, receipt });
}, 200_000);
