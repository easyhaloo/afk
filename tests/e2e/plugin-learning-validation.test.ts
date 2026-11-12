import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { CandidateStore } from '../../packages/runtime/src/application/learning/candidate-store.js';
import { buildEvidencePack } from '../../packages/runtime/src/application/learning/evidence.js';
import { knowledgeFixture, page, wikiScript } from '../../packages/runtime/src/application/learning/knowledge.fixture.spec.js';
import { createLessonPublicationFixture } from '../../packages/runtime/src/application/learning/lesson-publication.fixture.spec.js';
import { JsonlEventStore } from '../../packages/runtime/src/infrastructure/observability/jsonl-event-store.js';

const execute = promisify(execFile);
const binary = resolve('apps/cli/dist/index.js');
const fixtures: ReturnType<typeof knowledgeFixture>[] = [];
const lessonCleanups: Array<() => void> = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
  for (const cleanup of lessonCleanups.splice(0).reverse()) cleanup();
});

async function setup() {
  const fixture = knowledgeFixture();
  fixtures.push(fixture);
  const home = join(fixture.root, 'home');
  const workspace = join(fixture.root, 'workspace');
  const targetRoot = join(fixture.root, 'authority');
  const extension = join(fixture.root, 'checker-package');
  await Promise.all([home, workspace, targetRoot, extension].map(directory => fs.mkdir(directory)));
  const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
    PATH: ['/usr/bin', '/bin'].join(delimiter), AFK_EVENT_STORE_DIR: join(fixture.root, 'events'),
    AFK_LOG_DIR: join(fixture.root, 'logs'), NO_COLOR: '1', LANG: 'C', LC_ALL: 'C' };
  const command = async (...args: string[]) => {
    try {
      const result = await execute(process.execPath, [binary, ...args], { cwd: workspace, env, timeout: 15_000 });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const failure = error as { code?: number | string; stdout?: string; stderr?: string };
      if (typeof failure.code !== 'number') throw error;
      return { code: failure.code, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
    }
  };
  let sequence = 0;
  const configure = async (id: string, config: unknown, builtin = true) => {
    const file = join(fixture.root, `plugin-config-${sequence++}.json`);
    await fs.writeFile(file, JSON.stringify(config), { mode: 0o600 });
    const result = await command('plugin', 'configure', id, ...(builtin ? ['--builtin'] : []), '--file', file);
    expect(result, `plugin configure ${id}`).toMatchObject({ code: 0 });
  };
  const scope = fixture.policy.scope;
  const events = new JsonlEventStore({ root: env.AFK_EVENT_STORE_DIR });
  await events.append([{ id: 'observed-approval', schemaVersion: 1, type: 'agent.session_recorded',
    occurredAt: '2026-11-11T00:00:00Z', correlationId: 'approval-source',
    context: { runId: 'approval-source', traceId: 'approval-trace', workItemId: `${scope}#42`,
      profileId: 'default', attempt: 1, actor: { kind: 'system', id: 'cli-e2e' } },
    data: { kind: 'agent.session_recorded', sessionId: 'approval-session' } }]);
  const audit = { id: 'audit-1', kind: 'audit' as const, path: events.pathFor('approval-source'),
    allowedRoot: env.AFK_EVENT_STORE_DIR, runId: 'approval-source' };
  const pack = await buildEvidencePack({ sources: [audit] });
  const file = join(home, '.afk', 'learning', 'candidates.sqlite');
  const store = new CandidateStore({ file });
  let candidate;
  try {
    const source = store.submitRequest({ request: { version: 1, scope, sourceId: 'run:approval-source',
      sourceRunId: 'approval-source', evidenceDigest: pack.digest, analyzerVersion: '1', reason: 'import' },
      evidence: pack.entries.map(entry => entry.ref) }, pack);
    const receipt = store.completeRequest(source.key, { version: 1, warnings: [],
      candidates: [{ ...fixture.candidate.proposal, evidenceIds: pack.entries.map(entry => entry.ref.id) }] });
    candidate = store.getCandidate(receipt.candidateIds[0]!)!;
    expect(candidate).toMatchObject({ state: 'candidate', version: 1 });
    expect(store.getValidation(candidate.id)).toBeUndefined();
  } finally { store.close(); }
  const inspect = () => {
    const reopened = new CandidateStore({ file });
    try { return { candidate: reopened.getCandidate(candidate.id), receipt: reopened.getValidation(candidate.id) }; }
    finally { reopened.close(); }
  };
  const identity = { scope, checkerId: 'approval-rules', providerId: 'approval-oracle', version: '1' };
  const authority = { subject: 'approval', rule: 'Approve before publishing', authority: pack.entries.map(entry => entry.ref.locator) };
  const authorityFile = join(targetRoot, 'approval.json');
  const callsFile = join(fixture.root, 'checker-calls.jsonl');
  await fs.writeFile(authorityFile, JSON.stringify(authority), { mode: 0o600 });
  await fs.writeFile(callsFile, '', { mode: 0o600 });
  const configurationFile = join(fixture.root, 'checkers.json');
  const validation = { version: 1, checkers: [{ ...identity, authorizationFile: fixture.authorizationFile,
    target: { ref: 'wiki:approval', root: targetRoot, path: 'approval.json' },
    evidence: [{ digest: pack.digest, sources: [audit] }] }] };
  await fs.writeFile(configurationFile, JSON.stringify(validation), { mode: 0o600 });
  const manifest = { id: 'verification.approval-cli-e2e', version: '1.0.0', apiVersion: 1,
    provides: ['verification.provider'], trusted: true, entry: 'index.js',
    configSchema: { type: 'object', additionalProperties: false, required: ['authorityFile', 'callsFile'],
      properties: { authorityFile: { type: 'string', minLength: 1 }, callsFile: { type: 'string', minLength: 1 } } } };
  await fs.writeFile(join(extension, 'package.json'), JSON.stringify({ name: 'approval-cli-e2e', version: '1.0.0', type: 'module' }));
  await fs.writeFile(join(extension, 'plugin.json'), JSON.stringify(manifest));
  await fs.writeFile(join(extension, 'index.js'), `
    import { appendFileSync, readFileSync } from 'node:fs';
    const manifest = ${JSON.stringify(manifest)};
    const identity = ${JSON.stringify(identity)};
    export default ({ configuration }) => ({ manifest, activate(context) {
      context.registerVerificationProvider(identity.providerId, {
        id: identity.providerId,
        capabilities: { 'test-execution': true, 'static-analysis': false, 'custom-script': false },
        async doctor() {
          return [{ check: 'learning-validation-v1', ok: true, detail: JSON.stringify(identity) }];
        },
        async verify(request) {
          appendFileSync(configuration.callsFile, JSON.stringify({ operation: 'verify', pid: process.pid }) + '\\n');
          const observed = JSON.parse(readFileSync(configuration.authorityFile, 'utf8'));
          const actual = new Map([['fact.subject', observed.subject], ['fact.rule', observed.rule], ['fact.authority', observed.authority]]);
          const envelope = JSON.parse(request.target);
          return { passed: true, durationMs: 1, output: JSON.stringify({ protocol: 'learning-validation-v1', binding: envelope.binding,
            assertions: envelope.assertions.map(assertion => ({ ...assertion, actual: actual.get(assertion.node), status: 'observed' })) }) };
        }
      });
    } });
  `);
  expect(await command('plugin', 'install', extension)).toMatchObject({ code: 0 });
  expect(await fs.readFile(join(home, '.afk', 'plugins', manifest.id, 'install.json'), 'utf8')).toContain(manifest.id);
  await configure(manifest.id, { authorityFile, callsFile }, false);
  const learningConfig = { enabled: true, dailyCalls: 0, validation: { configurationFile } };
  await configure('learning.distiller', learningConfig);
  const validate = (options: { scope?: string; expectedVersion?: number } = {}) => command('experience', 'validate', candidate.id,
    '--scope', options.scope ?? scope, '--expected-version', String(options.expectedVersion ?? 1), '--checker', identity.checkerId, '--json');
  const calls = async () => (await fs.readFile(callsFile, 'utf8')).split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { operation: string; pid: number });
  return { ...fixture, home, file, candidate, identity, authority, authorityFile, configurationFile, validation,
    learningConfig, command, configure, validate, inspect, calls };
}

describe('built CLI installed learning validation checker', () => {
  it('prepares, publishes, recalls and withdraws a QA-validated lesson through the built CLI', async () => {
    const current = await createLessonPublicationFixture({ registerCleanup: cleanup => lessonCleanups.push(cleanup),
      versions: ['fixture-v1'], includeFact: true });
    await fs.writeFile(join(current.vault, 'template.md'), page('{{title}}', '{{knowledge}}'));
    await fs.writeFile(join(current.vault, 'index.md'), page('Index', '[[backlinks]]'));
    await fs.writeFile(join(current.vault, 'backlinks.md'), page('Backlinks', '[[index]]'));
    current.store.close();
    const home = join(current.root, 'home');
    const directory = join(home, '.afk', 'learning');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const ledgerFile = join(directory, 'candidates.sqlite');
    await fs.copyFile(current.file, ledgerFile);
    const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), PATH: process.env.PATH,
      AFK_LOG_DIR: join(current.root, 'logs'), NO_COLOR: '1', LANG: 'C', LC_ALL: 'C' };
    const command = (...args: string[]) => execute(process.execPath, [binary, ...args], { cwd: current.root, env, timeout: 30_000 });
    const configuration = join(current.root, 'learning-plugin-config.json');
    await fs.writeFile(configuration, JSON.stringify({ enabled: true, dailyCalls: 0,
      validation: { configurationFile: current.configurationFile }, knowledge: { wikiScript, grants: [current.authorizationFile] } }), { mode: 0o600 });
    await command('plugin', 'configure', 'learning.distiller', '--builtin', '--file', configuration);
    const prepared = JSON.parse((await command('experience', 'knowledge', 'prepare', current.candidate.id,
      '--scope', current.scope, '--expected-version', String(current.candidate.version), '--json')).stdout);
    expect(prepared).toMatchObject({ phase: 'prepared', candidateId: current.candidate.id });
    const published = JSON.parse((await command('experience', 'knowledge', 'publish', prepared.key, '--scope', current.scope, '--json')).stdout);
    expect(published).toMatchObject({ publication: { phase: 'committed', key: prepared.key } });
    const target = join(current.vault, 'Retry.md');
    expect(await fs.readFile(target, 'utf8')).toContain(current.revision);
    const input = join(current.root, 'recall.json');
    const recall = async (version: string) => {
      await fs.writeFile(input, JSON.stringify({ scope: current.scope, prompt: 'duplicate retry', applicability: { version } }));
      return JSON.parse((await command('plugin', 'invoke', 'context.provider', 'context.knowledge', 'gather', '--input', input, '--json')).stdout);
    };
    expect(await recall('fixture-v1')).toHaveLength(1);
    expect(await recall('fixture-v2')).toEqual([]);
    await current.append('independent-qa', [{ kind: 'qa.failed', reason: 'Retry fix regressed' }]);
    expect(await recall('fixture-v1')).toEqual([]);
    const reconcile = async () => JSON.parse((await command('experience', 'knowledge', 'reconcile', '--scope', current.scope, '--json')).stdout);
    expect(await reconcile()).toMatchObject({ blocked: [], results: [{ withdrawal: { status: 'withdrawn' } }] });
    expect(await fs.readFile(target, 'utf8')).toContain('knowledge_status: revoked');
    expect(await reconcile()).toMatchObject({ blocked: [] });
    const ledger = new CandidateStore({ file: ledgerFile });
    try {
      expect(ledger.getCandidate(current.candidate.id)?.state).toBe('conflict');
      expect(ledger.getCandidate(current.candidateIds[1])?.state).toBe('candidate');
      expect(ledger.getRequest(current.source.key)?.blockedReason).toBeUndefined();
    } finally { ledger.close(); }
  }, 60_000);

  it('rejects scope/version mismatches and persists a real independent checker receipt through the built CLI', async () => {
    const fixture = await setup();
    for (const [options, code] of [
      [{ scope: 'github:other/private' }, 'scope_mismatch'],
      [{ expectedVersion: 2 }, 'stale_candidate'],
    ] as const) {
      const result = await fixture.validate(options);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({ status: 'blocked', code });
    }
    expect(fixture.inspect()).toMatchObject({ candidate: { state: 'candidate', version: 1 }, receipt: undefined });
    expect(await fixture.calls()).toEqual([]);
    const result = await fixture.validate();
    expect(result.code).toBe(0);
    const validated = JSON.parse(result.stdout);
    expect(validated).toMatchObject({ status: 'validated', candidateId: fixture.candidate.id, candidateVersion: 1, validatedVersion: 2 });
    expect(validated.executionId).toEqual(expect.any(String));
    expect(validated.receiptDigest).toMatch(/^[a-f0-9]{64}$/);
    const persisted = fixture.inspect();
    expect(persisted.candidate).toMatchObject({ id: fixture.candidate.id, state: 'validated', version: 2 });
    expect(persisted.receipt).toMatchObject({ candidateId: fixture.candidate.id, candidateVersion: 1, validatedVersion: 2,
      candidateDigest: fixture.candidate.digest, evidenceDigest: fixture.candidate.evidenceDigest, passed: true,
      validatorVersion: `learning-validation-v1:${validated.executionId}` });
    const calls = await fixture.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ operation: 'verify', pid: expect.any(Number) });
    expect(calls[0].pid).not.toBe(process.pid);
    const stale = await fixture.validate();
    expect(stale.code).toBe(1);
    expect(JSON.parse(stale.stdout)).toEqual({ status: 'blocked', code: 'stale_candidate' });
    expect(fixture.inspect()).toEqual(persisted);
    expect(await fixture.calls()).toEqual(calls);
  }, 60_000);

  it('rejects disagreement from independently read authority even when the installed provider returns passed true', async () => {
    const fixture = await setup();
    await fs.writeFile(fixture.authorityFile, JSON.stringify({ ...fixture.authority, rule: 'Publish without approval' }));
    const result = await fixture.validate();
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ status: 'blocked', code: 'assertion_failed' });
    expect(await fixture.calls()).toHaveLength(1);
    expect(fixture.inspect()).toMatchObject({ candidate: { state: 'candidate', version: 1 }, receipt: undefined });
  }, 60_000);

  it('does not fall back to the installed oracle or execute an ordinary test-runner as a semantic checker', async () => {
    const fixture = await setup();
    fixture.validation.checkers[0].providerId = 'not-installed';
    await fs.writeFile(fixture.configurationFile, JSON.stringify(fixture.validation));
    const absent = await fixture.validate();
    expect(absent.code).toBe(1);
    expect(JSON.parse(absent.stdout)).toEqual({ status: 'blocked', code: 'checker_unavailable' });
    const marker = join(fixture.root, 'ordinary-runner-executed');
    await fixture.configure('verification.test-runner', { command: [process.execPath, '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'must not execute')`] });
    fixture.validation.checkers[0].providerId = 'test-runner';
    await fs.writeFile(fixture.configurationFile, JSON.stringify(fixture.validation));
    const ordinary = await fixture.validate();
    expect(ordinary.code).toBe(1);
    expect(JSON.parse(ordinary.stdout)).toEqual({ status: 'blocked', code: 'checker_unavailable' });
    await expect(fs.readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fixture.calls()).toEqual([]);
    expect(fixture.inspect()).toMatchObject({ candidate: { state: 'candidate', version: 1 }, receipt: undefined });
  }, 60_000);

  it('fails safely for missing validation configuration and disabled learning without changing the ledger', async () => {
    const fixture = await setup();
    for (const config of [{ enabled: true, dailyCalls: 0 }, { ...fixture.learningConfig, enabled: false }]) {
      await fixture.configure('learning.distiller', config);
      const result = await fixture.validate();
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Learning validation failed');
      expect(result.stdout + result.stderr).not.toContain(fixture.configurationFile);
      expect(fixture.inspect()).toMatchObject({ candidate: { state: 'candidate', version: 1 }, receipt: undefined });
      expect(await fixture.calls()).toEqual([]);
    }
  }, 60_000);
});
