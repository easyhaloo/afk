import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import type { RunEvent } from '@afk/core';
import { createLessonPublicationFixture } from '../../packages/runtime/src/application/learning/lesson-publication.fixture.spec.js';
import { page, wikiScript } from '../../packages/runtime/src/application/learning/knowledge.fixture.spec.js';
import { CandidateStore } from '../../packages/runtime/src/application/learning/candidate-store.js';
import { reconcileDistillationSources } from '../../packages/runtime/src/application/learning/intake.js';
import { validateConfiguredLearningCandidate } from '../../packages/runtime/src/application/learning/validation-runtime.js';
import { runRepositoryTemplate, withRepositoryTemplate } from './workflow-templates.fixture.js';
import { checkHookReceipt, checkRequiredHookFailure, installFailingHook } from './workflow-hook-receipt.fixture.js';

const execute = promisify(execFile);
const entry = resolve(process.env.AFK_E2E_CLI_ENTRY ?? 'apps/cli/dist/index.js');
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  vi.unstubAllEnvs();
});

it.concurrent.each(['issue-implementation', 'merge-conflict-resolution'])('%s reaches verification after a local fixture change', async template => {
  const repair = template === 'merge-conflict-resolution';
  const { result, requests, first, verify, conflicts, verifiedContent, parents } = await runRepositoryTemplate(entry, repair);
  expect(first).toContain(repair ? '解决 QA 工作树中未完成的合并冲突' : '实现 issue #1');
  expect(conflicts.trim()).toBe(repair ? 'shared.txt' : '');
  expect(verify).toContain('验证 issue #1');
  expect(verifiedContent.trim()).toBe('applied');
  expect(parents).toHaveLength(repair ? 2 : 1);
  expect(requests).toContainEqual(expect.stringMatching(/^GET .*\/issues\/1$/));
  expect(result.code).toBe(1);
  expect(requests.some(request => /^POST .*\/merge_requests$/.test(request))).toBe(false);
});

async function setup(kind: string) {
  const fixture = await createLessonPublicationFixture({ managed: true, repair: kind === 'repair', versions: ['repair-v1'],
    registerCleanup: close => cleanup.push(close) });
  const { root, events, workItemId, sourceInput } = fixture;
  const cwd = join(root, 'workspace');
  await mkdir(cwd);
  const bin = join(root, 'bin');
  await mkdir(bin);
  const env = { HOME: root, USERPROFILE: root, PATH: bin, AFK_EVENT_STORE_DIR: events.root,
    AFK_LOG_DIR: join(root, 'logs'), NO_COLOR: '1' };
  const cli = (...args: string[]) => execute(process.execPath, [entry, ...args], { cwd, env, timeout: 15_000 });
  const config = join(root, 'learning.json');
  await writeFile(config, JSON.stringify({ enabled: true, dailyCalls: 0,
    validation: { configurationFile: fixture.configurationFile },
    ...(kind === 'repair' || kind === 'success' ? { knowledge: { wikiScript, grants: [fixture.authorizationFile] } } : {}) }));
  await cli('plugin', 'configure', 'learning.distiller', '--builtin', '--file', config);
  const review = () => cli('experience', 'review', '--kind', kind, '--run-id', sourceInput.runId,
    '--backlog-id', workItemId, '--checker', 'lesson-checker', '--json');
  return { fixture, cli, review, bin };
}

it.concurrent.each(['issue-implementation', 'merge-conflict-resolution'])('%s continues after a receipted optional hook failure', async template => {
  const repair = template === 'merge-conflict-resolution';
  const { first, conflicts, parents, verifiedContent, requests } = await runRepositoryTemplate(entry, repair, true);
  expect(first).toContain(repair ? '解决 QA 工作树中未完成的合并冲突' : '实现 issue #1');
  expect(conflicts.trim()).toBe(repair ? 'shared.txt' : '');
  expect(parents).toHaveLength(repair ? 2 : 1);
  expect(verifiedContent.trim()).toBe('applied');
  expect(requests.filter(request => /^POST .*\/merge_requests$/.test(request))).toHaveLength(1);
  expect(requests.some(request => /\/merge_requests\/\d+\/merge$/.test(request))).toBe(false);
});

it.concurrent.each(['issue-implementation', 'merge-conflict-resolution'])('%s stops before launching an agent when a required hook fails', async template => {
  await withRepositoryTemplate(entry, template === 'merge-conflict-resolution', 'required', async ({ root, cli, workItemId, result, requests }) => {
    expect(result.code).toBe(1);
    await expect(access(join(root, 'first-prompt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(requests.some(request => /^POST .*\/merge_requests$/.test(request))).toBe(false);
    await checkRequiredHookFailure(root, cli, workItemId);
  });
});

it('blocks a learning review before processing evidence when a required hook fails', async () => {
  const { fixture: { root, events, workItemId, scope }, cli, review } = await setup('success');
  const sourceRuns = await events.listRuns();
  const sourceAudits = await Promise.all(sourceRuns.map(run => readFile(events.pathFor(run))));
  await installFailingHook(root, cli, 'required');
  await expect(review()).rejects.toMatchObject({ code: 1 });
  await checkRequiredHookFailure(root, cli, workItemId, events.root);
  expect(JSON.parse((await cli('experience', 'jobs', '--scope', scope, '--json')).stdout)).toEqual([]);
  expect(await Promise.all(sourceRuns.map(run => readFile(events.pathFor(run))))).toEqual(sourceAudits);
});

it.each([
  ['success', 'success-review-preview'], ['repair', 'repair-review-preview'],
  ['skill', 'skill-optimization-validation'], ['tool', 'tool-optimization-validation'],
])('%s review captures the exact source and stops at zero analysis budget', async (kind, template) => {
  const { fixture: { events, scope, workItemId, sourceInput }, cli, review: runReview } = await setup(kind);
  const sources = await events.listRuns();
  const originals = await Promise.all(sources.map(run => readFile(events.pathFor(run))));
  const query = async (resource: string) => JSON.parse((await cli('experience', resource, '--scope', scope, '--json')).stdout);
  expect(await query('jobs')).toEqual([]);
  await expect(runReview()).rejects.toMatchObject({
    code: 1, stdout: '', stderr: expect.stringContaining('Learning review failed'),
  });
  expect(await query('jobs')).toEqual([expect.objectContaining({ scope, workItemId, sourceRunId: sourceInput.runId,
    status: 'blocked', reasonCode: 'budget_exhausted', attempts: [] })]);
  expect(await query('candidates')).toEqual([]);
  const reviews = (await events.listRuns()).filter(run => !sources.includes(run));
  expect(reviews).toHaveLength(1);
  const review = reviews[0]!;
  expect(JSON.parse((await cli('observe', 'verify', review, '--json')).stdout)).toMatchObject({ valid: true });
  const history: RunEvent[] = [];
  for await (const event of events.read(review)) history.push(event);
  expect(history.every(event => event.context.workItemId === workItemId && event.context.purpose === 'learning')).toBe(true);
  expect(history.map(event => event.data)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'workflow.recorded', name: template }),
    expect.objectContaining({ kind: 'effect.completed', effectKind: 'learning.retrospective', outcome: 'failed' }),
  ]));
  expect(history.at(-1)?.data).toMatchObject({ kind: 'run.finished', outcome: 'failed' });
  expect(await Promise.all(sources.map(run => readFile(events.pathFor(run))))).toEqual(originals);
});

it.each(['repair', 'success'])('prepares the exact prevalidated %s candidate via CLI without publishing it', async kind => {
  const { fixture, review, cli, bin } = await setup(kind);
  const { root, events, scope, workItemId, configurationFile, vault } = fixture;
  const runId = fixture.sourceInput.runId;
  const directory = join(root, '.afk', 'learning');
  const capture = await reconcileDistillationSources({ directory, homeDir: root, eventRoot: events.root,
    runId, scope, workItemId, includeFailed: true });
  expect(capture.requestKeys).toHaveLength(1);
  const requestKey = capture.requestKeys[0]!;
  const file = join(directory, 'candidates.sqlite');
  const store = new CandidateStore({ file });
  cleanup.push(() => store.close());
  const evidenceIds = store.getRequest(requestKey)!.evidence.filter(ref => ref.kind === 'audit').map(ref => ref.id);
  const proposal = { ...fixture.candidate.proposal, evidenceIds };
  const processPayload = { entry: 'Retry requested', systems: ['queue'], preconditions: [],
    steps: [{ id: 'serialize', action: 'Serialize retry', stateChange: 'Retry queued', evidenceIds }],
    exceptions: [], completion: 'Retry queued' };
  if (kind === 'success') {
    const { scope, checkerId, providerId, version, authorizationFile, target } = fixture.configuration.checkers[0]!;
    await writeFile(configurationFile, JSON.stringify({ version: 1, checkers: [
      { scope, checkerId, providerId, version, authorizationFile, target },
    ] }));
    await writeFile(fixture.oracle, JSON.stringify({ 'process.entry': 'Retry requested', 'process.systems': ['queue'],
      'process.preconditions': [], 'process.stepCount': '1', 'process.steps.0.action': 'Serialize retry', 'process.steps.0.stateChange': 'Retry queued',
      'process.applicability.preconditions': [], 'process.applicability.exclusions': [], 'process.applicability.invalidationConditions': [],
      'process.exceptions': [], 'process.completion': 'Retry queued' }));
  }
  const { candidateIds } = store.completeRequest(requestKey, { version: 1, warnings: [],
    candidates: [kind === 'repair' ? proposal : { ...proposal, kind: 'process', title: 'Queue retries', statement: 'Serialize retries', payload: processPayload }] });
  const candidateId = candidateIds[0]!;
  const validated = await validateConfiguredLearningCandidate({ scope, candidateId, expectedVersion: 1, checkerId: 'lesson-checker' },
    { file, homeDir: root, configurationFile, resolveProvider: async () => fixture.provider });
  expect(validated).toMatchObject({ status: 'validated', validatedVersion: 2 });
  const python = (await execute('python3', ['-c', 'import sys; print(sys.executable)'])).stdout.trim();
  await symlink(python, join(bin, 'python3'));
  const ripgrep = (await execute(python, ['-c', 'import shutil, sys; sys.stdout.write(shutil.which("rg") or sys.exit("rg required"))'])).stdout;
  await symlink(ripgrep, join(bin, 'rg'));
  for (const [name, body] of [['template', '{{knowledge}}'], ['index', '[[backlinks]]'], ['backlinks', '[[index]]']] as const) {
    await writeFile(join(vault, `${name}.md`), page(name === 'template' ? '{{title}}' : name, body));
  }
  if (kind === 'success') await installFailingHook(root, cli);
  const result = JSON.parse((await review()).stdout);
  if (kind === 'success') await checkHookReceipt(root, cli, workItemId, 'success-review-preview', events.root);
  expect(result).toMatchObject({ scope, runId, requestKey, processing: { candidateIds: [candidateId] },
    prepared: [{ candidateId, validatedVersion: 2, publication: { phase: 'prepared', targetRef: 'wiki:retry' } }] });
  expect(store.listPublications()).toEqual([expect.objectContaining({ phase: 'prepared', candidateId })]);
  await expect(access(join(vault, 'Retry.md'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([
  ['issue-implementation', ['implement', 'verify-ac', 'publish', 'queue-qa']],
  ['merge-conflict-resolution', ['resolve-conflicts']],
] as const)('loads the built-in %s graph through the CLI', async (template, steps) => {
  const cwd = await mkdtemp(join(tmpdir(), 'w07-graph-'));
  try {
    const result = await execute(process.execPath, [entry, 'graph', 'workflow', template, '--validate'],
      { cwd, env: { HOME: cwd, USERPROFILE: cwd, PATH: cwd }, timeout: 15_000 });
    expect(JSON.parse(result.stdout).nodes.map((node: { stepId: string }) => node.stepId)).toEqual(steps);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
