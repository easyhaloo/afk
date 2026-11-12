import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CandidateStore } from './candidate-store.js';
import { candidateProposalSchema } from './contracts.js';
import { hash, knowledgeFixture } from './knowledge.fixture.spec.js';
import { output } from './ledger-data.fixture.spec.js';
import { prepareKnowledgePublication, publishLearningCandidate, readPublishedKnowledge, resolveKnowledgePublication } from './publication.js';

type Fixture = ReturnType<typeof knowledgeFixture>;
type WorkerEvent = { event: string; pid: number; key?: string; phase?: string; error?: string; withdrawal?: unknown };
type WorkerExit = { code: number | null; signal: NodeJS.Signals | null; error?: string };
type Worker = { child: ChildProcess; events: WorkerEvent[]; exit: Promise<WorkerExit>; stderr: () => string };
type LinterEntry = { pid: number; parent: number; inherited: boolean; target: string };

const fixtures: Fixture[] = [];
const workers: Worker[] = [];
let bundleDirectory: string;
let workerScript: string;
const pause = (milliseconds: number) => new Promise<void>(resolveTurn => setTimeout(resolveTurn, milliseconds));

beforeAll(async () => {
  bundleDirectory = mkdtempSync(join(realpathSync(tmpdir()), 'publication-process-bundle-'));
  workerScript = join(bundleDirectory, 'publisher.mjs');
  await build({ stdin: { contents: `
    import { writeFileSync } from 'node:fs';
    import { CandidateStore } from './candidate-store.js';
    import { prepareKnowledgePublication, publishLearningCandidate } from './publication.js';
    const { ledgerFile, armFile, armAt, waitForPublish, publicationKey, crashAt, ...options } = JSON.parse(process.argv[2]);
    const store = new CandidateStore({ file: ledgerFile });
    if (crashAt) {
      const supersede = store.supersedePreparedPublication.bind(store);
      store.supersedePreparedPublication = (...args) => {
        if (crashAt === 'before-cas') process.kill(process.pid, 'SIGKILL');
        const successor = supersede(...args);
        process.kill(process.pid, 'SIGKILL');
        return successor;
      };
    }
    const notify = (event, details = {}) => process.send?.({ event, pid: process.pid, ...details });
    const start = new Promise(resolveStart => process.once('message', resolveStart));
    notify('ready');
    await start;
    try {
      if (armAt === 'prepare') writeFileSync(armFile, 'armed');
      notify('prepare-started');
      const prepared = publicationKey ? { key: publicationKey } : await prepareKnowledgePublication({ ...options, store });
      const publish = waitForPublish ? new Promise(resolvePublish => process.once('message', resolvePublish)) : undefined;
      notify('prepared', { key: prepared.key });
      if (publish) await publish;
      if (armAt === 'publish') writeFileSync(armFile, 'armed');
      notify('publish-started', { key: prepared.key });
      const result = await publishLearningCandidate({ ...options, store, key: prepared.key });
      notify('result', { key: result.publication.key, phase: result.publication.phase,
        withdrawal: result.withdrawal, error: result.errorCode === undefined ? undefined : String(result.errorCode) });
    } catch (error) {
      notify('failure', { error: error instanceof Error ? error.stack : String(error) });
      process.exitCode = 1;
    } finally {
      store.close();
      process.disconnect();
    }
  `, resolveDir: fileURLToPath(new URL('.', import.meta.url)) }, outfile: workerScript,
  bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
});

afterEach(async () => {
  for (const fixture of fixtures) writeFileSync(join(fixture.root, 'release-linter'), 'release');
  for (const worker of workers.splice(0)) {
    try {
      if (process.platform === 'win32') worker.child.kill('SIGKILL');
      else if (worker.child.pid) process.kill(-worker.child.pid, 'SIGKILL');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    await worker.exit;
  }
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

afterAll(() => { if (bundleDirectory) rmSync(bundleDirectory, { recursive: true, force: true }); });

function open(): Fixture {
  const fixture = knowledgeFixture();
  fixtures.push(fixture);
  const backend = `import json, os, pathlib, sys, time
control = pathlib.Path(${JSON.stringify(fixture.root)})
owner = pathlib.Path(__file__).parent.parent
descriptor = os.environ.get('LEARNING_PUBLICATION_LOCK_FD')
inherited = False
if descriptor is not None:
    actual = os.fstat(int(descriptor))
    expected = (owner / '.learning-publication.lock').stat()
    inherited = (actual.st_dev, actual.st_ino) == (expected.st_dev, expected.st_ino)
entry = dict(pid=os.getpid(), parent=os.getppid(), inherited=inherited, target=sys.argv[sys.argv.index('--vault') + 1])
with (control / 'linter-calls.jsonl').open('a') as stream:
    stream.write(json.dumps(entry) + '\\n')
if (control / 'arm-linter').exists():
    try:
        gate = os.open(control / 'claimed-linter', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        pass
    else:
        os.close(gate)
        (control / 'entered-linter.json').write_text(json.dumps(entry))
        deadline = time.monotonic() + 20
        while not (control / 'release-linter').exists():
            if time.monotonic() >= deadline:
                raise RuntimeError('Test linter gate timed out')
            time.sleep(0.01)
print(json.dumps(dict(findings=[])))
`;
  fixture.write('.tools/wiki-lint.py', backend);
  fixture.policy.rules['.tools/wiki-lint.py'] = hash(backend);
  fixture.persistGrant();
  return fixture;
}

function launch(fixture: Fixture, candidate = fixture.candidate, armAt?: 'prepare' | 'publish', waitForPublish = false,
  restart?: { publicationKey: string; crashAt?: 'before-cas' | 'after-cas' }): Worker {
  const { store: _store, ...options } = fixture.input;
  const child = spawn(process.execPath, [workerScript, JSON.stringify({ ...options,
    candidateId: candidate.id, expectedVersion: candidate.version, ledgerFile: join(fixture.root, 'ledger.sqlite'),
    armFile: join(fixture.root, 'arm-linter'), armAt, waitForPublish, ...restart })], {
    cwd: process.cwd(), detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, LEARNING_PUBLICATION_LOCK_FD: undefined },
  });
  const events: WorkerEvent[] = [];
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr = (stderr + chunk).slice(-16_384); });
  child.on('message', message => { events.push(message as WorkerEvent); });
  const exit = new Promise<WorkerExit>(resolveExit => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolveExit({ code: null, signal: 'SIGKILL', error: 'Publisher exceeded 25 second deadline' });
    }, 25_000);
    child.once('error', error => { clearTimeout(timeout); resolveExit({ code: null, signal: null, error: error.message }); });
    child.once('exit', (code, signal) => { clearTimeout(timeout); resolveExit({ code, signal }); });
  });
  const worker = { child, events, exit, stderr: () => stderr };
  workers.push(worker);
  return worker;
}

async function event(worker: Worker, name: string): Promise<WorkerEvent> {
  await vi.waitFor(() => {
    expect(worker.events.find(entry => entry.event === 'failure'), worker.stderr()).toBeUndefined();
    expect(worker.events.some(entry => entry.event === name), JSON.stringify(worker.events)).toBe(true);
  }, { timeout: 10_000, interval: 20 });
  return worker.events.find(entry => entry.event === name)!;
}

async function entered(fixture: Fixture): Promise<LinterEntry> {
  const marker = join(fixture.root, 'entered-linter.json');
  let entry: LinterEntry | undefined;
  await vi.waitFor(() => {
    expect(existsSync(marker)).toBe(true);
    entry = JSON.parse(readFileSync(marker, 'utf8')) as LinterEntry;
    expect(entry.pid).toBeGreaterThan(0);
  }, { timeout: 10_000, interval: 20 });
  return entry!;
}

function linterCalls(fixture: Fixture): LinterEntry[] {
  const file = join(fixture.root, 'linter-calls.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as LinterEntry) : [];
}

function kernelLockState(fixture: Fixture): string {
  return execFileSync('python3', ['-B', '-c', `
import fcntl, os, sys
descriptor = os.open(sys.argv[1], os.O_RDWR)
try:
    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    print('acquired')
except BlockingIOError:
    print('blocked')
finally:
    os.close(descriptor)
`, join(fixture.vault, '.learning-publication.lock')], { encoding: 'utf8', timeout: 2000 }).trim();
}

async function committed(worker: Worker): Promise<WorkerEvent> {
  const outcome = await worker.exit;
  expect(outcome, JSON.stringify(worker.events) + worker.stderr()).toEqual({ code: 0, signal: null });
  const result = worker.events.find(entry => entry.event === 'result');
  expect(result, JSON.stringify(worker.events)).toMatchObject({ phase: 'committed' });
  expect(result?.withdrawal).toBeUndefined();
  expect(result?.error).toBeUndefined();
  return result!;
}

async function assertPublished(fixture: Fixture, candidateIds: string[]): Promise<void> {
  const store = new CandidateStore({ file: join(fixture.root, 'ledger.sqlite') });
  try {
    for (const candidateId of candidateIds) {
      expect(store.getCandidate(candidateId)?.state).toBe('published');
      const publications = store.listPublications(candidateId);
      const active = publications.filter(publication => publication.phase !== 'superseded');
      expect(active).toHaveLength(1);
      expect(active[0].phase).toBe('committed');
      expect(active[0].observedDigest).toBe(active[0].targetDigest);
      for (const publication of publications) {
        expect(resolveKnowledgePublication({ ...fixture.input, store, key: publication.key }).key).toBe(active[0].key);
        expect(await readPublishedKnowledge({ ...fixture.input, store, key: publication.key,
          applicability: { version: 'abc' } })).not.toBeNull();
        expect(existsSync(join(fixture.recoveryDirectory, publication.key, 'withdrawal.json'))).toBe(false);
      }
    }
  } finally { store.close(); }
}

function billingCandidate(fixture: Fixture) {
  fixture.policy.targets.push({ ...fixture.policy.targets[0], ref: 'wiki:billing', paths: ['知识/Billing.md'] });
  fixture.persistGrant();
  const request = fixture.store.getRequest(fixture.candidate.requestKey)!;
  const next = fixture.store.submitRequest({ request: { ...request.request, sourceId: 'run:billing', sourceRunId: 'billing' }, evidence: request.evidence });
  const processed = fixture.store.completeRequest(next.key, { version: 1, warnings: [], candidates: [candidateProposalSchema.parse({
    ...output.candidates[0], title: 'Billing', statement: 'Billing requires approval', targetRef: 'wiki:billing',
    payload: { subject: 'billing', rule: 'Approve before billing', classification: 'fact' },
  })] });
  const candidate = fixture.store.getCandidate(processed.candidateIds[0])!;
  return fixture.store.recordValidation(candidate.id, candidate.version, { candidateDigest: candidate.digest,
    evidenceDigest: candidate.evidenceDigest, validatorVersion: 'knowledge-v1', passed: true, results: ['fixture evidence checked'] });
}

describe.skipIf(process.platform === 'win32')('real publication processes sharing a vault', () => {
  it('converges two independent Node prepare/publish callers for the same candidate', async () => {
    const fixture = open();
    fixture.store.close();
    const first = launch(fixture, fixture.candidate, 'prepare', true);
    const second = launch(fixture, fixture.candidate, undefined, true);
    await Promise.all([event(first, 'ready'), event(second, 'ready')]);
    expect(first.child.pid).not.toBe(second.child.pid);
    first.child.send('go');
    await entered(fixture);
    second.child.send('go');
    await event(second, 'prepare-started');
    try {
      await pause(750);
      expect(second.events.map(entry => entry.event)).not.toContain('prepared');
      expect(linterCalls(fixture)).toHaveLength(1);
    } finally { writeFileSync(join(fixture.root, 'release-linter'), 'release'); }
    const prepared = await Promise.all([event(first, 'prepared'), event(second, 'prepared')]);
    expect(prepared[0].key).toBe(prepared[1].key);
    first.child.send('publish');
    second.child.send('publish');
    const results = await Promise.all([committed(first), committed(second)]);
    expect(results[0].key).toBe(results[1].key);
    await assertPublished(fixture, [fixture.candidate.id]);
    for (const path of ['00-总览.md', '知识/入口.md']) {
      expect(readFileSync(join(fixture.vault, path), 'utf8').split('[[知识/Approval]]')).toHaveLength(2);
    }
    expect(readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8')).not.toContain('knowledge_status: revoked');
  }, 45_000);

  it('retains both real shared-index updates from distinct candidate publishers', async () => {
    const fixture = open();
    const billing = billingCandidate(fixture);
    fixture.store.close();
    const first = launch(fixture, fixture.candidate, 'prepare', true);
    const second = launch(fixture, billing, undefined, true);
    await Promise.all([event(first, 'ready'), event(second, 'ready')]);
    first.child.send('go');
    await entered(fixture);
    second.child.send('go');
    await event(second, 'prepare-started');
    try {
      await pause(750);
      expect(second.events.map(entry => entry.event)).not.toContain('prepared');
      expect(linterCalls(fixture)).toHaveLength(1);
    } finally { writeFileSync(join(fixture.root, 'release-linter'), 'release'); }
    await Promise.all([event(first, 'prepared'), event(second, 'prepared')]);
    first.child.send('publish');
    second.child.send('publish');
    const results = await Promise.all([committed(first), committed(second)]);
    expect(results[0].key).not.toBe(results[1].key);
    await assertPublished(fixture, [fixture.candidate.id, billing.id]);
    for (const path of ['00-总览.md', '知识/入口.md']) {
      const content = readFileSync(join(fixture.vault, path), 'utf8');
      for (const target of ['Approval', 'Billing']) expect(content.split(`[[知识/${target}]]`)).toHaveLength(2);
    }
    for (const target of ['Approval', 'Billing']) {
      expect(readFileSync(join(fixture.vault, `知识/${target}.md`), 'utf8')).not.toContain('knowledge_status: revoked');
    }
  }, 45_000);

  it.each(['before-cas', 'after-cas'] as const)('replays the original key after SIGKILL %s without mutating old snapshots or withdrawing either candidate', async crashAt => {
    const fixture = open();
    const billing = billingCandidate(fixture);
    const input = { ...fixture.input, candidateId: billing.id, expectedVersion: billing.version };
    const approval = await prepareKnowledgePublication(fixture.input);
    const stale = await prepareKnowledgePublication(input);
    const snapshot = readFileSync(join(fixture.recoveryDirectory, stale.key, 'plan.json'));
    expect((await publishLearningCandidate({ ...fixture.input, key: approval.key })).publication.phase).toBe('committed');
    const navigation = ['00-总览.md', '知识/入口.md'].map(path => readFileSync(join(fixture.vault, path), 'utf8'));
    fixture.store.close();
    const crashed = launch(fixture, billing, undefined, false, { publicationKey: stale.key, crashAt });
    await event(crashed, 'ready');
    crashed.child.send('go');
    expect(await crashed.exit, JSON.stringify(crashed.events) + crashed.stderr()).toEqual({ code: null, signal: 'SIGKILL' });
    expect(existsSync(join(fixture.vault, '知识/Billing.md'))).toBe(false);
    expect(['00-总览.md', '知识/入口.md'].map(path => readFileSync(join(fixture.vault, path), 'utf8'))).toEqual(navigation);
    const orphanKey = readdirSync(fixture.recoveryDirectory).find(key => key !== approval.key && key !== stale.key)!;
    const replacementSnapshot = readFileSync(join(fixture.recoveryDirectory, orphanKey, 'plan.json'));
    const store = new CandidateStore({ file: join(fixture.root, 'ledger.sqlite') });
    try {
      expect(store.getCandidate(billing.id)).toMatchObject({ state: 'validated', version: billing.version });
      expect(store.getPublication(stale.key)).toMatchObject(crashAt === 'before-cas' ? { phase: 'prepared' }
        : { phase: 'superseded', supersededBy: orphanKey });
      expect(store.getPublication(orphanKey)?.phase).toBe(crashAt === 'before-cas' ? undefined : 'prepared');
    } finally { store.close(); }
    const restarted = launch(fixture, billing, undefined, false, { publicationKey: stale.key });
    await event(restarted, 'ready');
    restarted.child.send('go');
    expect((await committed(restarted)).key).toBe(orphanKey);
    await assertPublished(fixture, [fixture.candidate.id, billing.id]);
    expect(readFileSync(join(fixture.recoveryDirectory, stale.key, 'plan.json'))).toEqual(snapshot);
    expect(readFileSync(join(fixture.recoveryDirectory, orphanKey, 'plan.json'))).toEqual(replacementSnapshot);
    for (const path of ['00-总览.md', '知识/入口.md']) {
      const content = readFileSync(join(fixture.vault, path), 'utf8');
      for (const target of ['Approval', 'Billing']) expect(content.split(`[[知识/${target}]]`)).toHaveLength(2);
    }
  }, 45_000);

  it('keeps an orphan Python linter lock after SIGKILL of its Node publisher until the linter exits', async () => {
    const fixture = open();
    fixture.store.close();
    const first = launch(fixture, fixture.candidate, 'publish');
    await event(first, 'ready');
    first.child.send('go');
    const orphan = await entered(fixture);
    await event(first, 'publish-started');
    const callsBeforeKill = linterCalls(fixture).length;
    first.child.kill('SIGKILL');
    expect(await first.exit).toEqual({ code: null, signal: 'SIGKILL' });
    expect(() => process.kill(orphan.pid, 0)).not.toThrow();
    expect(() => process.kill(orphan.parent, 0)).not.toThrow();
    const kernel = kernelLockState(fixture);
    const second = launch(fixture);
    await event(second, 'ready');
    second.child.send('go');
    await event(second, 'prepare-started');
    try {
      await pause(750);
      expect(kernel).toBe('blocked');
      expect(orphan.inherited).toBe(true);
      expect(second.events.map(entry => entry.event)).not.toContain('prepared');
      expect(second.events.some(entry => entry.event === 'failure' || entry.event === 'result')).toBe(false);
      expect(linterCalls(fixture)).toHaveLength(callsBeforeKill);
      expect(existsSync(join(fixture.vault, '知识/Approval.md'))).toBe(false);
    } finally { writeFileSync(join(fixture.root, 'release-linter'), 'release'); }
    await committed(second);
    expect(kernelLockState(fixture)).toBe('acquired');
    await assertPublished(fixture, [fixture.candidate.id]);
  }, 45_000);
});
