import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { RunEventData } from '@afk/core';
import type { ContextFragment, ContextQuery } from '@afk/runtime/plugin-sdk';
import { expect, it } from 'vitest';
import { hash, page, wikiScript } from '../../../packages/runtime/src/application/learning/knowledge.fixture.spec.js';
import type { ExperienceRecord } from '../../../packages/runtime/src/application/learning/experience-store.js';
import { assertObservedRecall, recallCases } from './recall-v1.js';

const execute = promisify(execFile);
const installed = process.env.AFK_E2E_CLI_ENTRY;
const scope = 'github:w11/parcel';
const workItemId = `${scope}#19`;
const targetRef = 'wiki:label-offset';
const revision = 'a'.repeat(40);
const sourceRun = 'label-offset-failure';
const qaRun = 'label-offset-independent-qa';
const payload = { trigger: '标签发生纵向偏移', rootCause: '走纸刻度错误', rootCauseStatus: 'confirmed',
  attempts: ['调整模板留白无效'], fix: '重新标定走纸', prevention: ['检查走纸刻度'] };
const applicability = { project: scope, productId: 'parcel', environments: ['staging'], versions: ['2.0'], preconditions: ['feedDrift'],
  exclusions: [], invalidationConditions: [] };

async function publishFixture(home: string, runtime: string, cli: (...args: string[]) => Promise<string>, observeAlias: boolean) {
  const invoke = async (...args: string[]) => JSON.parse(await cli(...args, '--json'));
  const load = (name: string) => import(pathToFileURL(join(runtime, `${name}.js`)).href);
  const { JsonlEventStore } = await load('infrastructure/observability/jsonl-event-store') as typeof import('../../../packages/runtime/src/infrastructure/observability/jsonl-event-store.js');
  const { CandidateStore } = await load('application/learning/candidate-store') as typeof import('../../../packages/runtime/src/application/learning/candidate-store.js');
  const { buildEvidencePack } = await load('application/learning/evidence') as typeof import('../../../packages/runtime/src/application/learning/evidence.js');
  const events = new JsonlEventStore({ root: join(home, 'audit') });
  const append = (runId: string, data: RunEventData[]) => events.append(data.map((event, index) => ({
    id: `${runId}-${index}-${event.kind}`, schemaVersion: 1, type: event.kind, occurredAt: '2026-11-18T00:00:00Z', correlationId: runId,
    context: { runId, traceId: runId, workItemId, profileId: 'local-fixture', attempt: 1, actor: { kind: 'system', id: 'fixture' } }, data: event,
  })));
  const registration = { target: [20, 50], reproduced: [20, 56], afterCalibration: [20, 50] };
  const measurement = observeAlias ? { registration } : {};
  await append(sourceRun, [{ kind: 'qa.failed', reason: 'parcel 2.0 staging：标签发生纵向偏移且走纸刻度错误时重新标定走纸。模板留白错误时不适用。'
    + (observeAlias ? ` 标记位置 ${JSON.stringify(registration.reproduced)}，标称 ${JSON.stringify(registration.target)}。` : '') }]);
  await append(qaRun, [{ kind: 'qa.started' }, { kind: 'decision.made', command: 'experience.qa-target', accepted: true,
    reason: JSON.stringify({ target: { project: scope, revision, dirty: false } }) },
  ...(observeAlias ? [{ kind: 'decision.made' as const, command: 'fixture.registration-check', accepted: true, reason: JSON.stringify(registration) }] : []),
  { kind: 'qa.passed' },
  { kind: 'commit.recorded', phase: 'qa', branch: 'qa', commitSha: revision }, { kind: 'run.finished', outcome: 'succeeded' }]);
  const qaDigest = hash(await fs.readFile(events.pathFor(qaRun)));
  const source = { id: 'audit-1', kind: 'audit' as const, path: events.pathFor(sourceRun), allowedRoot: events.root, runId: sourceRun };
  const pack = await buildEvidencePack({ sources: [source] });
  const file = join(home, '.afk/learning/candidates.sqlite');
  const store = new CandidateStore({ file });
  let candidateId: string;
  try {
    const evidence = pack.entries.map(entry => entry.ref);
    const request = store.submitRequest({ request: { version: 1, scope, workItemId, sourceId: sourceRun, sourceRunId: sourceRun,
      analyzerVersion: 'local-fixture', reason: 'repaired', evidenceDigest: pack.digest }, evidence }, pack);
    [candidateId] = store.completeRequest(request.key, { version: 1, warnings: [], candidates: [{ kind: 'lesson', targetRef,
      title: '标签纵向偏移', statement: '重新标定走纸。模板留白错误不适用。', payload: observeAlias ? { ...payload, triggerAliases: ['上下错位'] } : payload,
      applicability, evidenceIds: evidence.map(ref => ref.id) }] }).candidateIds;
  } finally { store.close(); }

  const vault = join(home, 'wiki');
  await fs.mkdir(vault);
  const rules = '# Temporary W11 lesson wiki\n';
  await fs.writeFile(join(vault, 'AGENTS.md'), rules);
  for (const [name, title, body] of [['template', '{{title}}', '{{knowledge}}'], ['index', 'Index', '[[backlinks]]'], ['backlinks', 'Backlinks', '[[index]]']]) {
    await fs.writeFile(join(vault, `${name}.md`), page(title, body));
  }
  const save = async (name: string, value: unknown) => {
    const path = join(home, name);
    await fs.writeFile(path, JSON.stringify(value), { mode: 0o600 });
    return path;
  };
  const grant = await save('grant.json', { version: 1, revoked: false, allowWithdrawal: true, policy: { scope, vault,
    rules: { 'AGENTS.md': hash(rules), '.tools/wiki-lint.py': null }, targets: [{ ref: targetRef, kinds: ['lesson'], paths: ['Label.md'],
      inbox: false, templatePath: 'template.md', indexPaths: ['index.md'], backlinkPaths: ['backlinks.md'] }] } });
  const identity = { scope, checkerId: 'label-checker', providerId: 'semantic-lesson', version: '1' };
  const oracle = await save('oracle.json', { ...payload, ...applicability, ...measurement, applicabilityPreconditions: applicability.preconditions, fixTargetRevision: revision });
  const configurationFile = await save('checkers.json', { version: 1, checkers: [{ ...identity, authorizationFile: grant,
    allowLessonValidation: true, target: { ref: targetRef, root: home, path: 'oracle.json' }, evidence: [{ digest: pack.digest, sources: [source] }],
    qa: { scope, workItemId, runId: qaRun, targetRevision: revision, root: events.root, auditDigest: qaDigest } }] });
  const extension = join(home, 'checker');
  await fs.mkdir(extension);
  const manifest = { id: 'verification.label-fixture', apiVersion: 1, version: '1.0.0', trusted: true, provides: ['verification.provider'], entry: 'index.js' };
  await save('checker/package.json', { name: 'label-fixture', version: '1.0.0', type: 'module' });
  await save('checker/plugin.json', manifest);
  await fs.writeFile(join(extension, 'index.js'), `import { readFile } from 'node:fs/promises';
    const identity = ${JSON.stringify(identity)};
    export default () => ({ manifest: ${JSON.stringify(manifest)}, activate(context) {
      context.registerVerificationProvider(identity.providerId, { id: identity.providerId,
        capabilities: { 'test-execution': true, 'static-analysis': false, 'custom-script': false },
        doctor: async () => [{ check: 'learning-validation-v1', ok: true, detail: JSON.stringify(identity) }],
      async verify(request) {
        const { protocol, binding, assertions } = JSON.parse(request.target);
        const observed = JSON.parse(await readFile(${JSON.stringify(oracle)}, 'utf8'));
        if (observed.registration) {
          const { target, reproduced, afterCalibration } = observed.registration;
          observed.triggerAliases = ['左右错位', '上下错位'].filter((_, axis) =>
            reproduced[axis] !== target[axis] && afterCalibration[axis] === target[axis]);
        }
        return { passed: true, durationMs: 1, output: JSON.stringify({ protocol, binding, assertions: assertions.map(assertion =>
          ({ ...assertion, status: 'observed', actual: observed[assertion.node.slice('lesson.'.length)] })) }) };
      },
    }); } });`);
  await cli('plugin', 'install', extension);
  await cli('plugin', 'configure', 'learning.distiller', '--builtin', '--file', await save('config.json', { enabled: true, dailyCalls: 0,
    knowledge: { wikiScript, grants: [grant] }, validation: { configurationFile } }));
  const validation = await invoke('experience', 'validate', candidateId, '--scope', scope, '--expected-version', '1', '--checker', identity.checkerId);
  expect(validation).toMatchObject({ status: 'validated', candidateId, validatedVersion: 2, receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  const validated = new CandidateStore({ file });
  let aliasObservation;
  try {
    const chunks = validated.getValidation(candidateId)!.results;
    const receipt = JSON.parse(Buffer.from(chunks.map(chunk => chunk.slice('json-base64-v1:'.length)).join(''), 'base64').toString('utf8'));
    expect(receipt.receiptDigest).toBe(validation.receiptDigest);
    aliasObservation = receipt.report.assertions.find((assertion: { node: string }) => assertion.node === 'lesson.triggerAliases');
    if (observeAlias) expect(aliasObservation).toMatchObject({ status: 'observed', expected: ['上下错位'], actual: ['上下错位'], evidence: [expect.objectContaining({ digest: pack.entries[0].ref.digest })] });
    else expect(aliasObservation).toBeUndefined();
  } finally { validated.close(); }
  const prepared = await invoke('experience', 'knowledge', 'prepare', candidateId, '--scope', scope, '--expected-version', String(validation.validatedVersion));
  expect(prepared).toMatchObject({ phase: 'prepared', candidateId, targetRef });
  const { publication, experienceProjection } = await invoke('experience', 'knowledge', 'publish', prepared.key, '--scope', scope);
  expect(experienceProjection).toEqual({ blocked: [] });
  expect(publication).toMatchObject({ key: prepared.key, phase: 'committed', targetRef, candidateId, candidateVersion: validation.validatedVersion,
    evidenceDigest: pack.digest, validatorVersion: `learning-validation-v1:${validation.executionId}` });
  const pagePath = join(vault, 'Label.md');
  const pageContent = await fs.readFile(pagePath, 'utf8');
  expect(pageContent).toContain(revision);
  const material = JSON.parse(/\n```json\n([^\n]+)\n```/.exec(pageContent)![1]);
  expect(material).toMatchObject({ evidenceDigest: publication.evidenceDigest, proposal: { kind: 'lesson', targetRef,
    applicability: { project: scope, productId: 'parcel', versions: ['2.0'] } } });
  if (observeAlias) expect(material.proposal.payload.triggerAliases).toEqual(aliasObservation.actual);
  return { validation, publication, qaDigest, pagePath, append, aliasObservation };
}

const lessons = recallCases.filter(entry => entry.kind === 'lesson');
const frozen = (id: string) => lessons.find(entry => entry.id === id)!;

async function withInstalledCli(test: (home: string, runtime: string, cli: (...args: string[]) => Promise<string>) => Promise<void>) {
  const binary = await fs.realpath(installed!);
  const release = dirname(dirname(binary));
  const runtime = await fs.realpath(join(release, 'node_modules/@afk/runtime/dist'));
  expect(runtime.startsWith(`${release}/`)).toBe(true);
  const home = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'w11-installed-lesson-')));
  try {
    const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), PATH: process.env.PATH,
      AFK_LOG_DIR: join(home, 'logs'), AFK_EVENT_STORE_DIR: join(home, 'events'), NO_COLOR: '1' };
    const cli = async (...args: string[]) => (await execute(process.execPath, [binary, ...args], { cwd: home, env, timeout: 20_000 })).stdout;
    const manifest = JSON.parse(await fs.readFile(new URL('../../../apps/cli/package.json', import.meta.url), 'utf8'));
    expect((await cli('--version')).trim()).toBe(manifest.version);
    await test(home, runtime, cli);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
}

async function gather(home: string, cli: (...args: string[]) => Promise<string>, query: ContextQuery): Promise<ContextFragment[]> {
  const queryFile = join(home, 'query.json');
  await fs.writeFile(queryFile, JSON.stringify(query));
  return JSON.parse(await cli('plugin', 'invoke', 'context.provider', 'context.experience', 'gather', '--input', queryFile, '--json'));
}

it.skipIf(!installed)('scores lesson-06 on a fresh installed context.experience profile', () => withInstalledCli(async (home, _runtime, cli) => {
  const entry = frozen('lesson-06');
  for (const ledger of ['candidates.sqlite', 'experience.sqlite']) {
    await expect(fs.stat(join(home, '.afk/learning', ledger))).rejects.toMatchObject({ code: 'ENOENT' });
  }
  const fragments = await gather(home, cli, entry.query);
  expect(fragments).toEqual([]);
  assertObservedRecall(entry, { caseId: entry.id, status: 'observed', ranked: [] });
  console.log(JSON.stringify({ caseId: entry.id, binary: installed, profile: 'fresh', ranked: fragments }));
}));

it.skipIf(!installed).each(['lesson-01', 'lesson-02', 'lesson-03', 'lesson-04', 'lesson-05'])('scores installed local lesson %s', caseId =>
  withInstalledCli(async (home, runtime, cli) => {
    const entry = frozen(caseId);
    const invoke = async (...args: string[]) => JSON.parse(await cli(...args, '--json'));
    const { validation, publication, qaDigest, pagePath, append, aliasObservation } = await publishFixture(home, runtime, cli, caseId !== 'lesson-01');
    const records: ExperienceRecord[] = await invoke('experience', 'list', '--scope', scope);
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record).toMatchObject({ status: 'verified', scope, trigger: payload.trigger, action: payload.fix, verifiedEvidence: { runId: qaRun },
      source: { runId: sourceRun, workItemId }, publication: { key: publication.key, targetRef: publication.targetRef, candidateId: publication.candidateId,
        validatedVersion: publication.candidateVersion, validatorVersion: publication.validatorVersion, evidenceDigest: publication.evidenceDigest } });
    const origin = `experience:${record.id}; verification:run:${record.verifiedEvidence!.runId}; expires:${record.expiresAt}`;
    const query = frozen('lesson-01').query;
    const control = await gather(home, cli, query);
    expect(control).toEqual([{ origin, content: expect.stringContaining(record.action) }]);
    if (entry.id === 'lesson-01') {
      expect(await gather(home, cli, frozen('lesson-02').query)).toEqual([]);
      for (const productVersions of [{ other: '2.0' }, { parcel: '1.0' }, { parcel: '2.0', other: '2.0' }] as Record<string, string>[]) {
        expect(await gather(home, cli, { ...query, target: { ...query.target!, productVersions } })).toEqual([]);
      }
    }
    if (entry.id === 'lesson-02') {
      const aliasQuery = entry.query;
      for (const id of ['lesson-03', 'lesson-04']) {
        expect(await gather(home, cli, { ...frozen(id).query, prompt: aliasQuery.prompt })).toEqual([]);
      }
      for (const productVersions of [{ other: '2.0' }, { parcel: '1.0' }] as Record<string, string>[]) {
        expect(await gather(home, cli, { ...aliasQuery, target: { ...aliasQuery.target!, productVersions } })).toEqual([]);
      }
      for (const prompt of ['面单没有上下错位', '排除上下错位', '面单左右错位怎么恢复？']) {
        expect(await gather(home, cli, { ...aliasQuery, prompt })).toEqual([]);
      }
    }
    let withdrawal;
    if (entry.state === 'withdrawn') {
      await append(qaRun, [{ kind: 'qa.failed', reason: '走纸回归检查失败' }]);
      const reconciled = await invoke('experience', 'knowledge', 'reconcile', '--scope', scope);
      expect(reconciled).toMatchObject({ blocked: [], results: [{ withdrawal: { key: publication.key, status: 'withdrawn', evidenceDigest: publication.evidenceDigest } }] });
      withdrawal = reconciled.results[0].withdrawal;
      expect(await fs.readFile(pagePath, 'utf8')).toContain('knowledge_status: revoked');
      expect(await gather(home, cli, frozen('lesson-02').query)).toEqual([]);
    }
    const fragments = await gather(home, cli, entry.query);
    const ranked = fragments.map(fragment => {
      expect(fragment).toEqual(control[0]);
      const binding = record.publication!;
      return { scope: record.scope, key: binding.targetRef.slice('wiki:'.length), edition: binding.validatedVersion };
    });
    console.log(JSON.stringify({ caseId: entry.id, assetSource: 'local-fixture', binary: installed, runtime,
      scope: record.scope, publication: record.publication, validation: validation.receiptDigest, qaRun, qaDigest,
      controlOrigin: origin, ranked, withdrawal, aliasObservation }));
    assertObservedRecall(entry, { caseId: entry.id, status: 'observed', ranked });
  }), 60_000);
