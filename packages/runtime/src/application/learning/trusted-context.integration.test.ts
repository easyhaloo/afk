import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { simpleGit } from 'simple-git';
import { PluginManager } from '../plugins/manager.js';
import { createDefaultPluginRuntime } from '../plugins/default-runtime.js';
import { WorkflowRunner } from '../workflow-engine.js';
import { QARunner } from '../runners/qa-runner.js';
import { withLogContext } from '../../infrastructure/io/index.js';
import { ExperienceStore } from './experience-store.js';
import { experienceStorePath, prepareExperienceContext, resolveExperienceQueryContext } from './runtime.js';
import { knowledgeFixture } from './knowledge.fixture.spec.js';
import { candidateProposalSchema } from './contracts.js';
import { output } from './ledger-data.fixture.spec.js';
import { KnowledgeContextProvider, prepareConfiguredKnowledge, publishConfiguredKnowledge } from './knowledge-runtime.js';
import { readPublishedKnowledge } from './publication.js';

const cleanups: Array<() => unknown> = [];
const scope = 'github:acme/api';
const config = { targetBranch: 'main', completionTimeout: 1000, qaTimeout: 2000,
  contextThreshold: 100000, maxQaReworkAttempts: 3 } as any;
const trusted = { applicability: { version: 'asset-2', environment: 'ci' }, target: { project: scope,
  productVersions: { sqlite: '3.45' }, runtimeVersions: { node: '22.16' }, conditions: { approvalCondition: true } } };
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(saved = true) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'independent-context-'));
  const root = await fs.realpath(directory);
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  vi.stubEnv('HOME', root);
  vi.stubEnv('AFK_EVENT_STORE_DIR', join(root, '.afk/events'));
  const checkout = join(root, 'checkout');
  await fs.mkdir(checkout);
  const git = simpleGit(checkout);
  await git.init();
  await git.addConfig('user.name', 'Isolated review');
  await git.addConfig('user.email', 'review@example.test');
  await fs.writeFile(join(checkout, '.gitignore'), '.afk/\n');
  await git.add('.gitignore');
  await git.commit('isolated fixture');
  const revision = (await git.revparse('HEAD')).trim();
  const store = new ExperienceStore({ file: experienceStorePath(root) });
  const record = store.recordFailure({ scope, trigger: 'sqlite retry', rootCause: 'sqlite writer lock',
    action: 'use BEGIN IMMEDIATE and bounded retries', evidence: ['run:failed#failure.classified'],
    source: { runId: 'failed', workItemId: `${scope}#42` } });
  store.verify(record.id, { runId: 'qa-review', evidence: ['run:qa-review#regression'] }, trusted);
  store.close();
  const manager = new PluginManager({ homeDir: root });
  if (saved) await manager.configure('learning.distiller', { enabled: false, executionContexts: [trusted] }, true);
  const plugins = await createDefaultPluginRuntime({ homeDir: root, workspaceRoot: checkout });
  cleanups.push(() => plugins.dispose());
  return { root, checkout, git, revision, record, manager, plugins };
}

function workflow(plugins: any, experienceContext?: any) {
  const runner = new WorkflowRunner({ backlog: { claim: async () => null, get: async () => ({ id: '42', state: 'ready' }) } } as any,
    { plugins, experienceContext, observer: { record: async () => {} } as any,
      agentProvider: { name: 'claude-code', capabilities: new Set() } as any });
  return runner;
}

async function workflowPrompt(fixture: Awaited<ReturnType<typeof setup>>, experienceContext?: any) {
  const runner = workflow(fixture.plugins, experienceContext);
  await runner.run({ backlogId: '42', session: 'review', targetBranch: 'main',
    observationRunId: 'review-workflow', observationWorkItemId: `${scope}#42` });
  return (runner as any).resolveStepPrompt({ id: 'implement', prompt: 'sqlite retry; prompt Node 99' }, undefined, fixture.checkout);
}

async function qaProcess(fixture: Awaited<ReturnType<typeof setup>>, experienceContext?: any, canonicalLog = true, extra: any = {}) {
  const item = { id: '42', workItemId: `${scope}#42`, title: 'sqlite retry', description: 'sqlite retry; Node 99',
    dependsOn: [], state: 'verification', executionMode: 'afk', tags: [], branchName: 'feat/review', providerRef: '42' };
  const providers = { backlog: { get: async () => ({ ...item }), transition: async () => {}, setExecutionMode: async () => {},
      getActiveRework: async () => undefined, createRework: async () => ({ id: 'r1', cycle: 1, attempt: 1 }), resolveRework: async () => {} },
    changes: { findForBacklog: async () => null, create: async () => ({ id: 'pr-42', url: 'https://example.test/pr/42', mergeState: 'mergeable' }),
      get: async () => ({ id: 'pr-42', state: 'open', sourceBranch: 'qa-42', targetBranch: 'main', mergeState: 'mergeable' }) },
    branches: { createVerificationWorktree: async () => ({ branchName: 'qa-42', worktreePath: fixture.checkout }),
      commit: async () => ({ sha: fixture.revision, skippedBinaryFiles: [] }), mergeFeatureIntoBaseline: async () => ({ merged: true, conflicts: [] }),
      listUnresolvedConflicts: async () => [], push: async () => {}, cleanup: async () => {} } };
  const execution = { id: 'execution-review', metadata: { provider: 'claude-code', transport: 'process' },
    waitForEvent: async () => null, waitForResult: async () => ({ version: 1, runId: 'execution-review', status: 'completed', provider: 'batch',
      structuredOutput: { type: 'goal_complete', kind: 'qa', result: 'PASS', summary: 'isolated QA' }, commits: [] }),
    interrupt: async () => {}, kill: async () => {}, captureOutput: async () => '', captureSession: async () => undefined, resume: vi.fn() };
  const onExperienceTarget = vi.fn(async (_context: unknown) => {});
  const runner = new QARunner(providers as any, config, { plugins: fixture.plugins, experienceContext, onExperienceTarget,
    executionMode: 'batch', projectRoot: fixture.checkout, ...extra,
    agentProvider: { name: 'claude-code', capabilities: new Set(['streaming', 'structured-output']), createExecution: async () => execution } as any,
    sandboxProvider: { create: async () => ({ id: 'sandbox-review', worktreePath: fixture.checkout, workspacePath: fixture.checkout,
      startAgent: async () => execution, close: async () => {} }) } as any });
  const result = canonicalLog
    ? await withLogContext({ runId: 'review-qa', workItemId: `${scope}#42` }, () => runner.process('42'))
    : await runner.process('42');
  return { result, onExperienceTarget };
}

describe('trusted context production integration', () => {
  async function claimedWorkflow(fixture: Awaited<ReturnType<typeof setup>>, observationWorkItemId?: string) {
    const item = { id: '42', workItemId: `${scope}#42`, title: 'sqlite retry', state: 'ready' };
    const runner = new WorkflowRunner({ backlog: { get: async () => item,
      claim: async () => ({ item, release: async () => {} }),
      getActiveRework: async () => { throw new Error('stop after canonical claim'); } } } as any,
      { plugins: fixture.plugins, observer: { record: async () => {} } as any,
        agentProvider: { name: 'claude-code', capabilities: new Set() } as any });
    await expect(runner.run({ backlogId: '42', session: 'review', targetBranch: 'main', baseBranch: 'main', baseBranchExplicit: true,
      ...(observationWorkItemId ? { observationRunId: 'canonical-context', observationWorkItemId } : {}) }))
      .rejects.toThrow('stop after canonical claim');
    return runner;
  }

  it.each([undefined, `${scope}#42`, 'github:foreign/private#88'])('uses the claimed business identity with observation %s and excludes foreign assets', async observationWorkItemId => {
    const fixture = await setup();
    const store = new ExperienceStore({ file: experienceStorePath(fixture.root) });
    try {
      const foreign = store.recordFailure({ scope: 'github:foreign/private', trigger: 'sqlite retry', rootCause: 'sqlite writer lock',
        action: 'FOREIGN_ONLY_CORRECTION_71', evidence: ['run:foreign-failed#failure.classified'],
        source: { runId: 'foreign-failed', workItemId: 'github:foreign/private#88' } });
      store.verify(foreign.id, { runId: 'foreign-qa', evidence: ['run:foreign-qa#regression'] });
    } finally { store.close(); }
    const runner = await claimedWorkflow(fixture, observationWorkItemId);
    const segments = await (runner as any).resolveStepPrompt({ id: 'implement', prompt: 'sqlite retry' }, undefined, fixture.checkout);
    expect(segments.some((segment: any) => segment.label === 'verified experience reference')).toBe(true);
    const contents = await fs.readFile(join(fixture.checkout, '.afk/experience-context.md'), 'utf8');
    expect(contents).toContain(`experience:${fixture.record.id}`);
    expect(contents).not.toContain('FOREIGN_ONLY_CORRECTION_71');
  });

  it.each(['saved', 'explicit'] as const)('shares %s business conditions between implementation and QA when the execution repository is different', async source => {
    const fixture = await setup(source === 'saved');
    const experienceContext = source === 'explicit' ? trusted : undefined;
    const repository = { platform: 'github', projectKey: 'acme/implementation', primary: true, checkoutPath: fixture.checkout,
      repoRoot: fixture.checkout, baseBranch: 'main', workingBranch: 'feat/review' };
    const runner = workflow(fixture.plugins, experienceContext);
    await runner.run({ backlogId: '42', session: 'review', targetBranch: 'main',
      observationRunId: 'business-context', observationWorkItemId: `${scope}#42` });
    (runner as any).preparedRepositories = { repositories: [repository] };
    const segments = await (runner as any).resolveStepPrompt({ id: 'implement', prompt: 'sqlite retry' }, undefined, fixture.checkout);
    expect(segments.some((segment: any) => segment.label === 'verified experience reference')).toBe(true);
    expect(await fs.readFile(join(fixture.checkout, '.afk/experience-context.md'), 'utf8')).toContain(`experience:${fixture.record.id}`);
    const qa = await qaProcess(fixture, experienceContext, false, { repositories: [repository],
      prepareRepositories: { prepare: async () => ({ repositories: [repository], primary: { repoRoot: fixture.checkout,
        handle: { path: fixture.checkout } }, release: async () => {}, finish: async () => {} }) },
      runtimeManager: { start: async () => {}, heartbeat: async () => {}, finish: async () => {},
        writeDiagnostics: async () => {}, appendActivity: async () => {} } });
    expect(qa.result.success).toBe(true);
    expect(qa.onExperienceTarget.mock.calls[0]?.[0]).toMatchObject({ ...trusted,
      target: { ...trusted.target, project: scope, revision: fixture.revision, dirty: false } });
    expect(await fs.readFile(join(fixture.checkout, '.afk/experience-context.md'), 'utf8')).toContain(`experience:${fixture.record.id}`);
  });

  it('keeps the canonical QA business identity despite an unrelated logger scope', async () => {
    const fixture = await setup();
    const qa = await withLogContext({ runId: 'foreign-logger', workItemId: 'github:foreign/private#88' }, () => qaProcess(fixture, undefined, false));
    expect(qa.result.success).toBe(true);
    expect(qa.onExperienceTarget.mock.calls[0]?.[0]).toMatchObject(trusted);
  });

  it('rejects a foreign explicit target instead of adopting the execution repository as the business scope', async () => {
    const fixture = await setup();
    const experienceContext = { ...trusted, target: { ...trusted.target, project: 'github:acme/implementation' } };
    const runner = workflow(fixture.plugins, experienceContext);
    await runner.run({ backlogId: '42', session: 'review', targetBranch: 'main',
      observationRunId: 'foreign-target', observationWorkItemId: `${scope}#42` });
    (runner as any).preparedRepositories = { repositories: [{ platform: 'github', projectKey: 'acme/implementation', primary: true,
      checkoutPath: fixture.checkout, baseBranch: 'main', workingBranch: 'feat/review' }] };
    const segments = await (runner as any).resolveStepPrompt({ id: 'implement', prompt: 'sqlite retry' }, undefined, fixture.checkout);
    expect(segments.some((segment: any) => segment.label === 'verified experience reference')).toBe(false);
    const qa = await qaProcess(fixture, experienceContext, false);
    expect(qa.result.success).toBe(false);
    expect(qa.onExperienceTarget).not.toHaveBeenCalled();
    expect(await fs.stat(join(fixture.checkout, '.afk/experience-context.md')).then(() => true, () => false)).toBe(false);
  });

  it('does not use observation scope when the claimed canonical identity is malformed', async () => {
    const fixture = await setup();
    const runner = workflow(fixture.plugins);
    await runner.run({ backlogId: '42', session: 'review', targetBranch: 'main',
      observationRunId: 'malformed-canonical', observationWorkItemId: `${scope}#42` });
    (runner as any).activeBacklog = { id: '42', workItemId: 'invalid:canonical', title: 'sqlite retry' };
    const segments = await (runner as any).resolveStepPrompt({ id: 'implement', prompt: 'sqlite retry' }, undefined, fixture.checkout);
    expect(segments.some((segment: any) => segment.label === 'verified experience reference')).toBe(false);
    expect(await fs.stat(join(fixture.checkout, '.afk/experience-context.md')).then(() => true, () => false)).toBe(false);
  });

  it('PASS: saved configuration reaches real knowledge and experience providers in both runner prepare paths', async () => {
    const fixture = await setup();
    const knowledge = knowledgeFixture(candidateProposalSchema.parse({ ...output.candidates[0], targetRef: 'wiki:approval',
      applicability: { ...output.candidates[0]!.applicability, versions: ['asset-2'], environments: ['ci'], preconditions: ['approvalCondition'] } }));
    cleanups.push(() => knowledge.cleanup());
    knowledge.policy.targets[0]!.snapshot = true;
    knowledge.persistGrant();
    const input = { file: join(knowledge.root, 'ledger.sqlite'), recoveryDirectory: knowledge.recoveryDirectory,
      config: { wikiScript: knowledge.wikiScript, grants: [knowledge.authorizationFile] } };
    const publication = await prepareConfiguredKnowledge({ ...input, scope, candidateId: knowledge.candidate.id, expectedVersion: knowledge.candidate.version });
    await publishConfiguredKnowledge({ ...input, scope, key: publication.key });
    knowledge.store.close();
    await fs.copyFile(input.file, join(fixture.root, '.afk/learning/candidates.sqlite'));
    await fs.cp(knowledge.recoveryDirectory, join(fixture.root, '.afk/learning/publications'), { recursive: true });
    await fixture.manager.configure('learning.distiller', { enabled: false, executionContexts: [trusted], knowledge: input.config }, true);
    const plugins = await createDefaultPluginRuntime({ homeDir: fixture.root, workspaceRoot: fixture.checkout });
    cleanups.push(() => plugins.dispose());
    const configured = { ...fixture, plugins };
    for (const run of [() => workflowPrompt(configured), () => qaProcess(configured)]) {
      await run();
      const content = await fs.readFile(join(fixture.checkout, '.afk/experience-context.md'), 'utf8');
      expect(content).toContain(`experience:${fixture.record.id}`);
      expect(content).toContain(`knowledge:${publication.key}`);
    }
  });

  it('PASS: saved PluginManager config reaches actual prepare and both default runner constructors without experienceContext', async () => {
    const fixture = await setup();
    const dto = await fixture.plugins.dispatchSystemAction('learning.context', { scope }) as typeof trusted;
    dto.target.runtimeVersions.node = '99';
    const settings = await fixture.plugins.dispatchSystemAction('learning.settings', {}) as any;
    settings.executionContexts[0].target.conditions.approvalCondition = false;
    expect(await fixture.plugins.dispatchSystemAction('learning.context', { scope })).toEqual(trusted);
    expect(await fixture.plugins.dispatchSystemAction('learning.context', { scope: 'github:acme/other' })).toEqual({});
    const resolved = await resolveExperienceQueryContext({ workItemId: `${scope}#42`, worktreePath: fixture.checkout, plugins: fixture.plugins,
      target: { project: scope, revision: 'a'.repeat(40), dirty: true } });
    expect(resolved).toMatchObject({ ...trusted, target: { ...trusted.target, revision: fixture.revision, dirty: false } });
    expect(await prepareExperienceContext({ workItemId: `${scope}#42`, worktreePath: fixture.checkout, plugins: fixture.plugins, prompt: 'sqlite retry; Node 99' }))
      .toBe('.afk/experience-context.md');
    expect((await workflowPrompt(fixture)).some((segment: any) => segment.label === 'verified experience reference')).toBe(true);
    const qa = await qaProcess(fixture);
    expect.soft(qa.onExperienceTarget.mock.calls[0]?.[0]).toMatchObject(trusted);
    expect(await fs.stat(join(fixture.checkout, '.afk/experience-context.md')).then(() => true, () => false)).toBe(true);
    await fs.writeFile(join(fixture.checkout, 'dirty.txt'), 'dirty');
    expect((await resolveExperienceQueryContext({ workItemId: `${scope}#42`, worktreePath: fixture.checkout, plugins: fixture.plugins })).target?.dirty).toBe(true);
    for (const executionContexts of [[trusted, trusted], [{ target: { project: scope, revision: 'a'.repeat(40) } }], [{ target: { project: scope, dirty: false } }]]) {
      await expect(fixture.manager.configure('learning.distiller', { executionContexts }, true)).rejects.toThrow();
    }
  });

  it('SPEC: manual qa numeric backlog ID must still resolve the saved context using the canonical backlog workItemId', async () => {
    const fixture = await setup();
    const qa = await qaProcess(fixture, undefined, false);
    expect.soft(qa.onExperienceTarget.mock.calls[0]?.[0]).toMatchObject(trusted);
    expect(await fs.stat(join(fixture.checkout, '.afk/experience-context.md')).then(() => true, () => false)).toBe(true);
  });

  it.each(['target', 'applicability'])('SPEC: WorkflowRunner must not promote inherited %s in experienceContext', async field => {
    const fixture = await setup(false);
    const inherited = Object.assign(Object.create({ [field]: (trusted as any)[field] }), trusted);
    delete inherited[field];
    const segments = await workflowPrompt(fixture, inherited);
    expect(segments.some((segment: any) => segment.label === 'verified experience reference')).toBe(false);
  });

  it.each(['target', 'applicability'])('SPEC: QARunner must not promote inherited %s in experienceContext', async field => {
    const fixture = await setup(false);
    const inherited = Object.assign(Object.create({ [field]: (trusted as any)[field] }), trusted);
    delete inherited[field];
    await qaProcess(fixture, inherited);
    expect(await fs.stat(join(fixture.checkout, '.afk/experience-context.md')).then(() => true, () => false)).toBe(false);
  });

  it.each(['top-applicability', 'top-target', 'nested-version', 'nested-environment', 'nested-conditions'])('SPEC: all knowledge read entrances reject %s', async mode => {
    const fixture = knowledgeFixture(candidateProposalSchema.parse({ ...output.candidates[0], targetRef: 'wiki:approval',
      applicability: { ...output.candidates[0]!.applicability, environments: ['ci'], preconditions: ['approvalCondition'] } }));
    cleanups.push(() => fixture.cleanup());
    fixture.policy.targets[0]!.snapshot = true;
    fixture.persistGrant();
    const input = { file: join(fixture.root, 'ledger.sqlite'), recoveryDirectory: fixture.recoveryDirectory,
      config: { wikiScript: fixture.wikiScript, grants: [fixture.authorizationFile] } };
    const publication = await prepareConfiguredKnowledge({ ...input, scope: fixture.policy.scope, candidateId: fixture.candidate.id, expectedVersion: fixture.candidate.version });
    await publishConfiguredKnowledge({ ...input, scope: fixture.policy.scope, key: publication.key });
    const context: any = { applicability: { version: 'abc', environment: 'ci' }, target: { project: fixture.policy.scope, conditions: { approvalCondition: true } } };
    const provider = new KnowledgeContextProvider(input);
    expect(await provider.gather({ scope: fixture.policy.scope, prompt: 'Approval', ...context })).toHaveLength(1);
    let query: any = { scope: fixture.policy.scope, prompt: 'Approval', ...context };
    let direct: any = { ...fixture.input, key: publication.key, ...context };
    if (mode.startsWith('top-')) {
      const field = mode.slice(4);
      query = Object.assign(Object.create({ [field]: context[field] }), query); delete query[field];
      direct = Object.assign(Object.create({ [field]: context[field] }), direct); delete direct[field];
      expect(await provider.gather(query)).toEqual([]);
    } else if (mode === 'nested-version') {
      query.applicability = direct.applicability = Object.assign(Object.create({ version: 'abc' }), { environment: 'ci' });
      expect.soft(await provider.gather(query)).toEqual([]);
    } else if (mode === 'nested-environment') {
      query.applicability = direct.applicability = Object.assign(Object.create({ environment: 'ci' }), { version: 'abc' });
      expect.soft(await provider.gather(query)).toEqual([]);
    } else {
      query.target = direct.target = Object.assign(Object.create({ conditions: context.target.conditions }), { project: fixture.policy.scope });
      expect.soft(await provider.gather(query)).toEqual([]);
    }
    expect(await readPublishedKnowledge(direct)).toBeNull();
  });
});
