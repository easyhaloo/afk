import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import type { RunEvent } from '@afk/core';
import type { ExperienceContextReceipt, ExperienceMetrics, ExperienceOutcomeReceipt, ExperienceRecord } from '../../packages/runtime/src/application/learning/experience-store.js';
import { page, wikiScript } from '../../packages/runtime/src/application/learning/knowledge.fixture.spec.js';
import { createLessonPublicationFixture } from '../../packages/runtime/src/application/learning/lesson-publication.fixture.spec.js';
import { JsonlEventStore, verifyRunEventHistory } from '../../packages/runtime/src/infrastructure/observability/jsonl-event-store.js';

const execute = promisify(execFile);
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

it('publishes a validated lesson through the compiled CLI, binds Context and audited outcomes to its version, and withdraws across restart', async () => {
  const current = await createLessonPublicationFixture({ registerCleanup: cleanup => cleanups.push(cleanup),
    homeStorage: true, versions: ['fixture-v1'], includeFact: false });
  const home = current.root;
  const targetWorkItemId = `${current.scope}#42`;
  expect(targetWorkItemId).not.toBe(current.workItemId);
  expect(current.workItemId).toBe('github:acme/lesson#19');
  expect(current.candidateIds).toEqual([current.candidate.id]);
  expect(current.receipt).toMatchObject({ candidateVersion: 1, validatedVersion: 2, passed: true });
  await fs.writeFile(join(current.vault, 'template.md'), page('{{title}}', '{{knowledge}}'));
  await fs.writeFile(join(current.vault, 'index.md'), page('Index', '[[backlinks]]'));
  await fs.writeFile(join(current.vault, 'backlinks.md'), page('Backlinks', '[[index]]'));
  current.store.close();

  const bin = join(home, 'bin');
  await fs.mkdir(bin);
  const transport = await fs.readFile(resolve('tests/fixtures/plugin-matrix/execution/transport.mjs'), 'utf8');
  await fs.writeFile(join(bin, 'claude'), `#!${process.execPath}\n${transport}`, { mode: 0o755 });
  const runtime = resolve(process.env.AFK_E2E_RUNTIME_ROOT ?? 'packages/runtime/dist');
  const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
    PATH: [bin, process.env.PATH ?? '/usr/bin:/bin'].join(delimiter), MATRIX_RUNTIME: runtime, MATRIX_PERSIST_AUDIT: '1',
    MATRIX_WORK_ITEM_ID: targetWorkItemId, MATRIX_WORK_TITLE: 'duplicate retry',
    AFK_EVENT_STORE_DIR: join(home, 'consumer-events'), AFK_LOG_DIR: join(home, 'logs'), NO_COLOR: '1', LANG: 'C', LC_ALL: 'C' };
  const command = (...args: string[]) => execute(process.execPath,
    [resolve(process.env.AFK_E2E_CLI_ENTRY ?? 'apps/cli/dist/index.js'), ...args], { cwd: home, env, timeout: 30_000 });
  const cli = (...args: string[]) => command('experience', ...args);
  const compiled = (code: string, input: unknown) => execute(process.execPath, ['--input-type=module', '--eval', code, JSON.stringify(input)],
    { cwd: home, env, timeout: 30_000 });
  const moduleUrl = (path: string) => JSON.stringify(pathToFileURL(join(runtime, `${path}.js`)).href);
  const queryContext = { applicability: { version: 'fixture-v1' }, target: { project: current.scope } };
  const contextFile = join(home, 'experience-context.json');
  await fs.writeFile(contextFile, JSON.stringify(queryContext));
  const configuration = join(home, 'learning-plugin-config.json');
  await fs.writeFile(configuration, JSON.stringify({ enabled: true, dailyCalls: 0,
    executionContexts: [queryContext],
    knowledge: { wikiScript, grants: [current.authorizationFile] }, validation: { configurationFile: current.configurationFile } }), { mode: 0o600 });
  await command('plugin', 'configure', 'learning.distiller', '--builtin', '--file', configuration);

  const prepared = JSON.parse((await cli('knowledge', 'prepare', current.candidate.id, '--scope', current.scope,
    '--expected-version', String(current.candidate.version), '--json')).stdout);
  expect(prepared).toMatchObject({ phase: 'prepared', candidateId: current.candidate.id, targetRef: 'wiki:retry' });
  const published = JSON.parse((await cli('knowledge', 'publish', prepared.key, '--scope', current.scope, '--json')).stdout);
  expect(published).toMatchObject({ publication: { key: prepared.key, phase: 'committed' }, experienceProjection: { blocked: [] } });
  const publication = { key: prepared.key, candidateId: current.candidate.id, validatedVersion: current.receipt.validatedVersion,
    candidateDigest: current.candidate.digest, evidenceDigest: current.candidate.evidenceDigest,
    validatorVersion: current.receipt.validatorVersion, targetRef: 'wiki:retry' };
  const target = join(current.vault, 'Retry.md');
  const publishedPage = await fs.readFile(target, 'utf8');
  expect(publishedPage).toContain('Serialize retry read and write');
  expect(publishedPage).toContain(current.revision);

  const recall = async () => JSON.parse((await cli('recall', '--scope', current.scope, '--query', 'duplicate retry', '--context', contextFile, '--json')).stdout) as ExperienceRecord[];
  const records = await recall();
  expect(records).toHaveLength(1);
  const record = records[0]!;
  expect(record.id).not.toBe(current.candidate.id);
  expect(record).toMatchObject({ status: 'verified', publication, trigger: 'duplicate retry', action: 'Serialize retry read and write',
    source: { runId: 'original-failure', workItemId: current.workItemId } });
  expect(record.publication).toEqual(publication);
  expect(JSON.parse((await cli('recall', '--scope', current.scope, '--query', 'duplicate retry', '--json')).stdout)).toEqual([]);
  const mismatchedContextFile = join(home, 'mismatched-context.json');
  await fs.writeFile(mismatchedContextFile, JSON.stringify({ ...queryContext, applicability: { version: 'fixture-v2' } }));
  expect(JSON.parse((await cli('recall', '--scope', current.scope, '--query', 'duplicate retry', '--context', mismatchedContextFile, '--json')).stdout)).toEqual([]);
  const queryFile = join(home, 'context-query.json');
  await fs.writeFile(queryFile, JSON.stringify({ scope: current.scope, prompt: 'duplicate retry', ...queryContext }));
  const knowledge = async () => JSON.parse((await command('plugin', 'invoke', 'context.provider', 'context.knowledge',
    'gather', '--input', queryFile, '--json')).stdout);
  const fragments = await knowledge();
  expect(fragments).toEqual([{ origin: `knowledge:${prepared.key}; target:wiki:retry`, content: publishedPage }]);

  let sequence = 0;
  const run = async (mode: 'failure' | 'success') => {
    const runId = `lesson-lifecycle-${sequence++}`;
    const workspace = join(home, runId);
    await fs.mkdir(join(workspace, '.afk', 'workflows'), { recursive: true });
    await execute('git', ['init', '--initial-branch=main'], { cwd: workspace, env });
    await fs.writeFile(join(workspace, '.gitignore'), '.afk/\nmatrix-agent.json\nmanaged-result.json\n');
    await execute('git', ['add', '.gitignore'], { cwd: workspace, env });
    await execute('git', ['-c', 'user.name=Lesson Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false',
      'commit', '-m', 'fixture'], { cwd: workspace, env });
    await fs.writeFile(join(workspace, '.afk', 'workflows', 'matrix.yml'), JSON.stringify({ name: 'matrix', version: 1,
      steps: [{ id: 'implement', kind: 'agent', role: 'implementer', prompt: 'Run the deterministic subprocess fixture' },
        { id: 'queue', kind: 'system', action: 'queue-qa', dependsOn: ['implement'] }] }));
    await fs.writeFile(join(home, 'agent-mode'), mode);
    await execute(process.execPath, [resolve('tests/fixtures/plugin-matrix/execution/managed-run.mjs'), 'claude-code', 'local', mode],
      { cwd: workspace, env: { ...env, MATRIX_RUN_ID: runId }, timeout: 25_000 });
    return { workspace, runId, result: JSON.parse(await fs.readFile(join(workspace, 'managed-result.json'), 'utf8')) };
  };
  const snapshot = async (runId: string) => JSON.parse((await compiled(`
    import { ExperienceStore } from ${moduleUrl('application/learning/experience-store')};
    const { id, scope, source, file } = JSON.parse(process.argv[1]);
    const store = new ExperienceStore({ file, homeDir: process.env.HOME });
    try { console.log(JSON.stringify({ record: store.get(id, scope), contexts: store.contextReceipts({ scope, source }),
      outcomes: store.outcomeReceipts({ scope, source }), metrics: store.metrics({ scope }) })); }
    finally { store.close(); }
  `, { id: record.id, scope: current.scope, file: join(home, '.afk', 'learning', 'experience.sqlite'),
    source: { runId, workItemId: targetWorkItemId } })).stdout) as {
    record: ExperienceRecord; contexts: ExperienceContextReceipt[]; outcomes: ExperienceOutcomeReceipt[]; metrics: ExperienceMetrics;
  };
  const outcomes = async (runId: string, workItemId = targetWorkItemId) => JSON.parse((await cli('outcomes', '--scope', current.scope,
    '--run-id', runId, '--work-item-id', workItemId, '--json')).stdout) as ExperienceOutcomeReceipt[];

  const consumed = await run('failure');
  expect(consumed.result.result?.success).not.toBe(true);
  expect(consumed.result.effect).toMatchObject({ binary: 'claude', simulated: true, cwd: consumed.workspace });
  expect(consumed.result.effect.prompt || consumed.result.effect.argv.join(' ')).toContain('.afk/experience-context.md');
  expect(consumed.result.events).toContainEqual(expect.objectContaining({ kind: 'decision.made', command: 'experience.recall', accepted: true }));
  expect(consumed.result.events).toContainEqual(expect.objectContaining({ kind: 'failure.classified' }));
  const context = await fs.readFile(join(consumed.workspace, '.afk', 'experience-context.md'), 'utf8');
  expect(context).toContain(`experience:${record.id}; verification:run:independent-qa;`);
  expect(context).toContain(fragments[0].content);
  expect(context).toContain('Validated correction: Serialize retry read and write');

  const feedback = await snapshot(consumed.runId);
  expect(feedback.contexts).toHaveLength(2);
  const retrieved = feedback.contexts.find(receipt => receipt.stage === 'retrieved')!;
  const selected = feedback.contexts.find(receipt => receipt.stage === 'selected')!;
  expect(retrieved).toMatchObject({ experienceId: record.id, scope: current.scope, publication,
    source: { runId: consumed.runId, workItemId: targetWorkItemId } });
  expect(selected).toEqual({ ...retrieved, stage: 'selected', recordedAt: expect.any(String),
    retrievedFragmentDigest: retrieved.fragmentDigest, fragmentDigest: expect.any(String) });
  expect(selected.publication).toEqual(publication);
  const experienceFragment = `Trigger: ${record.trigger}\nRoot cause: ${record.rootCause}\nValidated correction: ${record.action}\nEvidence: ${record.verifiedEvidence!.evidence.join(', ')}`;
  const fragmentDigest = createHash('sha256').update(experienceFragment).digest('hex');
  expect(context).toContain(experienceFragment);
  expect(retrieved.fragmentDigest).toBe(fragmentDigest);
  expect(selected.fragmentDigest).toBe(fragmentDigest);
  expect(selected.verificationDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(selected.contextDigest).toMatch(/^[a-f0-9]{64}$/);

  const receipts = await outcomes(consumed.runId);
  expect(receipts.length).toBeGreaterThan(0);
  expect(feedback.outcomes).toEqual(receipts);
  expect(receipts).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: 'failure.classified', outcome: 'failed' }) }));
  const history: RunEvent[] = [];
  for await (const event of new JsonlEventStore({ root: env.AFK_EVENT_STORE_DIR }).read(consumed.runId)) history.push(event);
  expect(verifyRunEventHistory(consumed.runId, history).valid).toBe(true);
  for (const receipt of receipts) {
    expect(receipt).toMatchObject({ version: 1, stage: 'outcome', selected, recurrence: false, benefit: 'unknown',
      event: { runId: consumed.runId, outcome: 'failed' } });
    expect(receipt.selected).toEqual(selected);
    const event = history.find(entry => entry.sequence === receipt.event.sequence)!;
    expect(event).toMatchObject({ context: { runId: consumed.runId, workItemId: targetWorkItemId },
      integrity: { hash: receipt.event.hash }, data: { kind: receipt.event.type },
      occurredAt: receipt.event.occurredAt, observedAt: receipt.event.observedAt });
  }
  expect(feedback.metrics).toMatchObject({ adoptions: 0, recurrences: 0 });
  expect(await outcomes(consumed.runId, current.workItemId)).toEqual([]);
  await compiled(`
    import { recordExperienceOutcomes } from ${moduleUrl('application/learning/runtime')};
    await recordExperienceOutcomes(JSON.parse(process.argv[1]));
  `, { runId: consumed.runId, workItemId: targetWorkItemId, root: env.AFK_EVENT_STORE_DIR, homeDir: home });
  expect(await snapshot(consumed.runId)).toEqual(feedback);

  current.grant.revoked = true;
  current.persistGrant();
  expect(await recall()).toEqual([]);
  expect(await knowledge()).toEqual([]);
  expect(await fs.readFile(target, 'utf8')).toBe(publishedPage);
  expect(await outcomes(consumed.runId)).toEqual(receipts);
  const reconcile = async () => JSON.parse((await cli('knowledge', 'reconcile', '--scope', current.scope, '--json')).stdout);
  expect(await reconcile()).toMatchObject({ blocked: [], results: [{ publication: { key: prepared.key }, withdrawal: { status: 'withdrawn' } }] });
  expect(await fs.readFile(target, 'utf8')).toContain('knowledge_status: revoked');
  expect(await reconcile()).toMatchObject({ blocked: [] });
  const withdrawnPage = await fs.readFile(target, 'utf8');
  current.grant.revoked = false;
  current.persistGrant();

  const restarted = await run('success');
  expect(restarted.result.error).toBeUndefined();
  expect(restarted.result.result.success).toBe(true);
  expect(restarted.result.effect.prompt || restarted.result.effect.argv.join(' ')).not.toContain('.afk/experience-context.md');
  await expect(fs.readFile(join(restarted.workspace, '.afk', 'experience-context.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(restarted.result.events).not.toContainEqual(expect.objectContaining({ kind: 'decision.made', command: 'experience.recall', accepted: true }));
  expect(await recall()).toEqual([]);
  expect(await knowledge()).toEqual([]);
  expect((await snapshot(restarted.runId)).contexts).toEqual([]);
  expect(await outcomes(restarted.runId)).toEqual([]);
  expect(await snapshot(consumed.runId)).toEqual(feedback);
  expect(await outcomes(consumed.runId)).toEqual(receipts);
  expect(await fs.readFile(target, 'utf8')).toBe(withdrawnPage);
  const ledger = JSON.parse((await compiled(`
    import { CandidateStore } from ${moduleUrl('application/learning/candidate-store')};
    const { file, id, key } = JSON.parse(process.argv[1]);
    const store = new CandidateStore({ file });
    try { console.log(JSON.stringify({ candidate: store.getCandidate(id), validation: store.getValidation(id), publication: store.getPublication(key) })); }
    finally { store.close(); }
  `, { file: current.file, id: current.candidate.id, key: prepared.key })).stdout);
  expect(ledger.candidate).toMatchObject({ id: current.candidate.id, state: 'conflict', version: 4,
    digest: current.candidate.digest, evidenceDigest: current.candidate.evidenceDigest });
  expect(ledger.validation).toEqual(current.receipt);
  expect(ledger.publication).toEqual(published.publication);
  const calls = (await fs.readFile(join(home, 'transport.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(calls).toHaveLength(sequence);
  expect(calls.every((call: { binary: string }) => call.binary === 'claude')).toBe(true);
}, 120_000);
