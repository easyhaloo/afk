import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SystemActionExecutor } from '../workflows/system-actions.js';
import { createLearningPlugin, type LearningConfiguration } from './learning.js';
import { PluginRuntime } from './runtime.js';
import { buildEvidencePack } from '../learning/evidence.js';

const scope = 'github:acme/api';
const savedContext = { applicability: { environment: 'ci', version: 'asset-v2' },
  target: { project: scope, runtimeVersions: { node: '24' }, conditions: { approved: true } } };
const runtimes: PluginRuntime[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function envelope(action: string, input: unknown) {
  return { iid: 42, worktreePath: '/tmp/learning-workflow', branch: 'feat/learning', targetBranch: 'main',
    step: { id: 'learning-action', kind: 'system', action, input }, input };
}

async function fixture(config: Partial<LearningConfiguration> = {}) {
  const homeDir = mkdtempSync(join(realpathSync(tmpdir()), 'learning-workflow-'));
  directories.push(homeDir);
  const runtime = new PluginRuntime();
  runtimes.push(runtime);
  await runtime.activate(createLearningPlugin({ homeDir, config: { executionContexts: [savedContext], ...config } }));
  const publishChange = vi.fn();
  const queueQA = vi.fn();
  const executor = new SystemActionExecutor({ plugins: runtime, publishChange, queueQA });
  return { runtime, executor, homeDir, publishChange, queueQA };
}

describe('learning workflow input binding through production routing', () => {
  it('persists a workflow-submitted request and deduplicates a direct retry without model execution', async () => {
    const { runtime, executor, homeDir } = await fixture({ enabled: true });
    const path = join(homeDir, 'session.txt');
    writeFileSync(path, 'Require approval before publishing.');
    const pack = await buildEvidencePack({ sources: [{ id: 'session-1', kind: 'journal', path, allowedRoot: homeDir, format: 'text' }] });
    const request = { version: 1, scope, sourceId: 'run:workflow-42', sourceRunId: 'workflow-42', workItemId: `${scope}#42`,
      evidenceDigest: pack.digest, analyzerVersion: '1', reason: 'completed' };
    const input = { request, pack };
    const submitted = await executor.execute('learning.distill', envelope('learning.distill', input));
    expect(await runtime.dispatchSystemAction('learning.distill', input)).toEqual(submitted);
    expect(await executor.execute('learning.jobs', envelope('learning.jobs', { scope })))
      .toEqual([expect.objectContaining({ scope, status: 'pending', attempts: [] })]);
    expect(await executor.execute('learning.candidates', envelope('learning.candidates', { scope }))).toEqual([]);
    expect(await executor.execute('learning.jobs', envelope('learning.jobs', { scope: 'github:other/api' }))).toEqual([]);
  });

  it('keeps configured validation authoritative for workflow payloads', async () => {
    const { runtime, executor, homeDir } = await fixture({ enabled: true,
      validation: { configurationFile: join('/private', 'not-configured-checkers.json') } });
    const input = { scope, candidateId: 'a'.repeat(64), expectedVersion: 1, checkerId: 'approval-policy' };
    expect(await runtime.dispatchSystemAction('learning.validate', input)).toEqual({ status: 'blocked', code: 'candidate_unavailable' });
    expect(await executor.execute('learning.validate', envelope('learning.validate', input)))
      .toEqual({ status: 'blocked', code: 'candidate_unavailable' });
    for (const extra of [{ passed: true }, { target: '/private/forged' }, { command: ['sh', '-c', 'true'] }]) {
      expect(await executor.execute('learning.validate', envelope('learning.validate', { ...input, ...extra })))
        .toEqual({ status: 'blocked', code: 'invalid_input' });
    }
    expect(existsSync(join(homeDir, '.afk', 'learning', 'candidates.sqlite'))).toBe(false);
  });

  it.each([
    { action: 'learning.settings', input: {}, expected: expect.objectContaining({ enabled: false, executionContexts: [savedContext] }) },
    { action: 'learning.context', input: { scope }, expected: savedContext },
    { action: 'learning.context', input: { scope: 'github:other/api' }, expected: {} },
    { action: 'learning.jobs', input: { scope }, expected: [] },
    { action: 'learning.candidates', input: { scope }, expected: [] },
  ])('$action preserves direct DTO and workflow envelope parity for $input', async ({ action, input, expected }) => {
    const { runtime, executor, homeDir, publishChange, queueQA } = await fixture();
    const direct = await runtime.dispatchSystemAction(action, input);
    expect(direct).toEqual(expected);
    await expect(executor.execute(action, envelope(action, input), { authorizedWorkspace: '/tmp/learning-workflow' }))
      .resolves.toEqual(direct);
    expect(publishChange).not.toHaveBeenCalled();
    expect(queueQA).not.toHaveBeenCalled();
    expect(existsSync(join(homeDir, '.afk', 'learning', 'candidates.sqlite'))).toBe(false);
  });

  it.each([
    ['learning.settings', { command: ['sh', '-c', 'true'] }],
    ['learning.context', { scope, target: { project: 'github:other/api' } }],
    ['learning.jobs', { scope, provider: 'client-selected' }],
    ['learning.candidates', { scope, passed: true }],
    ['learning.context', { scope: 'not-a-project' }],
  ])('%s still strictly validates raw and nested payloads: %j', async (action, input) => {
    const { runtime, executor } = await fixture();
    await expect(runtime.dispatchSystemAction(action, input)).rejects.toThrow();
    await expect(executor.execute(action, envelope(action, input))).rejects.toThrow();
  });

  it('rejects input and step extras on raw DTOs and unwraps at most once', async () => {
    const { runtime, executor } = await fixture();
    for (const extra of [{ input: { scope } }, { step: envelope('learning.context', { scope }).step },
      { input: { scope }, step: envelope('learning.context', { scope }).step }]) {
      await expect(runtime.dispatchSystemAction('learning.context', { scope, ...extra })).rejects.toThrow();
      await expect(executor.execute('learning.context', envelope('learning.context', { scope, ...extra }))).rejects.toThrow();
    }
    await expect(executor.execute('learning.settings', envelope('learning.settings', envelope('learning.settings', {}))))
      .rejects.toThrow();
  });

  it.each([
    'absent input', 'absent step', 'inherited input', 'inherited step', 'wrong action', 'wrong kind',
    'absent kind', 'invalid step', 'invalid iid', 'empty worktreePath', 'empty branch', 'empty targetBranch', 'extra authority',
  ])('rejects a malformed envelope with %s', async defect => {
    const { executor } = await fixture();
    const valid = envelope('learning.settings', {});
    let malformed: { [Key in keyof ReturnType<typeof envelope> | 'authorizedWorkspace']?: unknown } = { ...valid };
    switch (defect) {
      case 'absent input': delete malformed.input; break;
      case 'absent step': delete malformed.step; break;
      case 'inherited input':
        delete malformed.input;
        malformed = Object.assign(Object.create({ input: valid.input }), malformed);
        break;
      case 'inherited step':
        delete malformed.step;
        malformed = Object.assign(Object.create({ step: valid.step }), malformed);
        break;
      case 'wrong action': malformed.step = { ...valid.step, action: 'learning.jobs' }; break;
      case 'wrong kind': malformed.step = { ...valid.step, kind: 'agent', role: 'reviewer', prompt: 'Review' }; break;
      case 'absent kind': {
        const { kind, ...step } = valid.step;
        malformed.step = { ...step, role: 'reviewer', prompt: 'Review' };
        break;
      }
      case 'invalid step': malformed.step = { ...valid.step, id: 'INVALID ID' }; break;
      case 'invalid iid': malformed.iid = 0; break;
      case 'empty worktreePath': malformed.worktreePath = ''; break;
      case 'empty branch': malformed.branch = ''; break;
      case 'empty targetBranch': malformed.targetBranch = ''; break;
      case 'extra authority': malformed.authorizedWorkspace = '/private/client-selected'; break;
    }
    await expect(executor.execute('learning.settings', malformed)).rejects.toThrow();
  });

  it.each([
    'learning.distill', 'learning.replay', 'learning.correct', 'learning.capture', 'learning.reconcile', 'learning.knowledge.prepare',
    'learning.validate', 'learning.knowledge.publish', 'learning.knowledge.reconcile', 'learning.worker.once', 'learning.retrospective',
  ])('%s remains disabled for raw DTOs and valid envelopes', async action => {
    const { runtime, executor, homeDir } = await fixture();
    await expect(runtime.dispatchSystemAction(action, {})).rejects.toThrow('learning_disabled');
    await expect(executor.execute(action, envelope(action, {}))).rejects.toThrow('learning_disabled');
    expect(existsSync(join(homeDir, '.afk', 'learning', 'candidates.sqlite'))).toBe(false);
  });

  it('preserves generic plugin envelope and operation options without unwrapping', async () => {
    const { runtime, executor } = await fixture();
    const action = vi.fn((input: unknown) => input);
    await runtime.activate({
      manifest: { id: 'test.workflow', version: '0.1.0', apiVersion: 1, provides: ['workflow.action'], trusted: true },
      activate: context => context.registerSystemAction('test.echo', action),
    });
    const input = envelope('test.echo', { scope });
    const options = { authorizedWorkspace: input.worktreePath };
    expect(await executor.execute('test.echo', input, options)).toBe(input);
    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith(input, options);
  });
});
