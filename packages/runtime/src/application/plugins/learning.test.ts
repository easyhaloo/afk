import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEvidencePack } from '../learning/evidence.js';
import { createBuiltinAgentPlugins } from './builtin-providers.js';
import { createConfiguredPlugins } from './configured.js';
import { builtinPluginManifests } from './builtin-manifests.js';
import { createLearningPlugin, learningPluginManifest } from './learning.js';
import { validatePluginConfig } from './configuration.js';
import { PluginRuntime } from './runtime.js';
import { createPluginRunObserver } from './observability.js';
import { CandidateStore } from '../learning/candidate-store.js';
import { LearningWorker } from '../learning/worker.js';
import { ClaudeCodeProvider } from '../../domain/agents/claude-code.js';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import { executeWorkItem } from '../workflows/execute-work-item.js';
import type { BacklogItem } from '../../domain/backlog/index.js';

const runtimes: PluginRuntime[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function fixture(config: unknown = {}) {
  const homeDir = mkdtempSync(join(realpathSync(tmpdir()), 'learning-plugin-'));
  directories.push(homeDir);
  const runtime = new PluginRuntime();
  runtimes.push(runtime);
  for (const plugin of createBuiltinAgentPlugins()) await runtime.activate(plugin);
  await runtime.activate(createLearningPlugin({ homeDir, config }));
  return { runtime, homeDir };
}

describe('optional learning plugin', () => {
  it('routes validation through saved configuration and rejects client-supplied execution authority', async () => {
    const config = { enabled: true, validation: { configurationFile: '/private/learning-checkers.json' } };
    validatePluginConfig(learningPluginManifest.configSchema, config);
    const { runtime, homeDir } = await fixture(config);
    const request = { scope: 'github:acme/api', candidateId: 'a'.repeat(64), expectedVersion: 1, checkerId: 'approval-policy' };
    expect(await runtime.dispatchSystemAction('learning.validate', request)).toEqual({ status: 'blocked', code: 'candidate_unavailable' });
    for (const extra of [{ passed: true }, { target: '/private/arbitrary' }, { command: ['sh', '-c', 'true'] }]) {
      expect(await runtime.dispatchSystemAction('learning.validate', { ...request, ...extra })).toEqual({ status: 'blocked', code: 'invalid_input' });
    }
    expect(existsSync(join(homeDir, '.afk', 'learning', 'candidates.sqlite'))).toBe(false);
    await runtime.close();
    await expect(runtime.dispatchSystemAction('learning.validate', request)).rejects.toThrow();
    for (const validation of [{}, { configurationFile: 'relative.json' }, { configurationFile: '/private/checkers.json', passed: true }]) {
      expect(() => createLearningPlugin({ config: { validation } })).toThrow();
    }
  });

  it('provides isolated copies of saved execution context for the exact project only', async () => {
    const context = { applicability: { environment: 'ci', version: 'asset-v2' },
      target: { project: 'github:acme/api', runtimeVersions: { node: '22.16' }, conditions: { approved: true } } };
    const config = { executionContexts: [context] };
    validatePluginConfig(learningPluginManifest.configSchema, config);
    const { runtime } = await fixture(config);
    expect(await runtime.dispatchSystemAction('learning.context', { scope: 'github:other/api' })).toEqual({});
    const selected = await runtime.dispatchSystemAction('learning.context', { scope: context.target.project }) as typeof context;
    selected.target.runtimeVersions.node = '99';
    const settings = await runtime.dispatchSystemAction('learning.settings', {}) as typeof config;
    settings.executionContexts[0].target.conditions.approved = false;
    expect(await runtime.dispatchSystemAction('learning.context', { scope: context.target.project })).toEqual(context);
  });

  it('rejects ambiguous, unbounded or fabricated saved execution targets', () => {
    const context = { target: { project: 'github:acme/api' } };
    for (const executionContexts of [[context, context], Array.from({ length: 65 }, () => context),
      [{ applicability: { environment: 'ci' } }], [{ target: { project: 'not-a-project' } }],
      [{ target: { ...context.target, revision: 'a'.repeat(40) } }], [{ target: { ...context.target, dirty: false } }],
      [{ target: { ...context.target, conditions: { approved: 'true' } } }]]) {
      expect(() => createLearningPlugin({ config: { executionContexts } })).toThrow();
    }
  });

  it('takes managed execution through independent QA and automatic intake to durable candidates', async () => {
    const { runtime, homeDir } = await fixture({ enabled: true });
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('AFK_EVENT_STORE_DIR', join(homeDir, '.afk', 'events'));
    const workItemId = 'github:acme/api#42';
    const current: BacklogItem = { id: workItemId, workItemId: workItemId as BacklogItem['workItemId'], issueNumber: 42,
      project: { platform: 'github', projectKey: 'acme/api', name: 'api' }, managed: true, executionEligible: true,
      title: 'Review publishing', dependsOn: [], state: 'ready', executionMode: 'afk', tags: [], branchName: 'feat/review', providerRef: workItemId };
    const providers = {
      backlog: { get: async () => current, isRunnable: async () => true, setExecutionMode: async () => undefined },
      branches: {}, changes: { findForBacklog: async () => current.state === 'merge_ready'
        ? { id: '5', url: 'https://example.test/pull/5', state: 'open' } : null, verifyIssueAssociation: async () => undefined },
    };
    const result = await executeWorkItem({ workItemId, executionId: 'managed-intake', runOptions: { executionMode: 'batch' } }, {
      plugins: runtime,
      lookupWorkItem: async () => current,
      readManifest: async () => ({ workItemId, providerBacklogId: '42', tracker: { platform: 'github', projectKey: 'acme/api' },
        workspaceRoot: homeDir, manifestPath: join(homeDir, 'manifest.json') }) as never,
      createContext: async () => ({ providers, request: { backlogId: '42', workspaceRoot: homeDir, repoRoot: homeDir, agentRuntime: { kind: 'default' } } }) as never,
      createImplementation: () => ({ run: async () => { current.state = 'verification'; return { success: true }; } }),
      createQA: () => ({ process: async () => { current.state = 'merge_ready'; return { success: true, mrUrl: 'https://example.test/pull/5' }; } }),
    });
    expect(result.status).toBe('merge_ready');
    const events = new JsonlEventStore({ root: join(homeDir, '.afk', 'events') });
    expect(await events.verify('managed-intake')).toMatchObject({ valid: true });
    expect(await runtime.dispatchSystemAction('learning.jobs', { scope: 'github:acme/api' })).toMatchObject([{ sourceRunId: 'managed-intake', status: 'pending' }]);
    const directory = join(homeDir, '.afk', 'learning');
    const store = new CandidateStore({ file: join(directory, 'candidates.sqlite') });
    const entry = store.listRequests()[0];
    store.close();
    const worker = new LearningWorker({ directory, enabled: true, provider: new ClaudeCodeProvider(), analyze: async () => ({ analysisRunId: 'fixture-analysis',
      output: { type: 'goal_complete', distillation: { version: 1, warnings: [], candidates: [{ kind: 'fact', title: 'Independent QA', statement: 'Independent QA precedes publication.',
        evidenceIds: [entry.evidence[0].id], applicability: { project: 'github:acme/api', environments: [], versions: [], preconditions: [], exclusions: [], invalidationConditions: [] },
        payload: { subject: 'publishing', rule: 'Independent QA precedes publication', classification: 'proposal' } }] } } }) });
    try { expect((await worker.runOnce()).processed).toBe(1); } finally { await worker.close(); }
    expect(await runtime.dispatchSystemAction('learning.candidates', { scope: 'github:acme/api' })).toMatchObject([{ state: 'candidate' }]);
  });

  it('reconciles missed producer events on Worker startup without bypassing a zero-call budget', async () => {
    const { runtime, homeDir } = await fixture({ enabled: true, dailyCalls: 0 });
    const context = { traceId: 'startup', runId: 'missed-producer', workItemId: 'github:acme/api#42', profileId: 'local', attempt: 1,
      actor: { kind: 'system' as const, id: 'test' } };
    const data = [{ kind: 'qa.started' as const }, { kind: 'qa.passed' as const }, { kind: 'run.finished' as const, outcome: 'succeeded' as const }];
    await new JsonlEventStore({ root: join(homeDir, '.afk', 'events') }).append(data.map((entry, index) => ({
      id: `startup-${index}`, schemaVersion: 1, type: entry.kind, occurredAt: new Date().toISOString(), context, correlationId: context.runId, data: entry,
    })));
    expect(await runtime.dispatchSystemAction('learning.worker.once', {})).toMatchObject({ processed: 0, blocked: 1 });
    expect(await runtime.dispatchSystemAction('learning.jobs', { scope: 'github:acme/api' })).toMatchObject([{ reasonCode: 'budget_exhausted', attempts: [] }]);
  });

  it('preserves the completed audit and exposes diagnostics when automatic capture is degraded', async () => {
    const { runtime, homeDir } = await fixture({ enabled: true });
    const observer = createPluginRunObserver(runtime, join(homeDir, '.afk', 'events'));
    const context = { traceId: 'degraded', runId: 'degraded', workItemId: 'github:acme/api#42', profileId: 'local', attempt: 1,
      actor: { kind: 'system' as const, id: 'test' } };
    await observer.record(context, { kind: 'qa.started' });
    await observer.record(context, { kind: 'agent.session_recorded', sessionId: 'outside', transcriptPath: join(homeDir, 'private.jsonl') });
    await observer.record(context, { kind: 'qa.passed' });
    expect(await observer.record(context, { kind: 'run.finished', outcome: 'succeeded' })).toMatchObject({ lastSequence: 4 });
    expect(await runtime.diagnostics('learning.distiller')).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'learning_capture_degraded' })]));
    expect(await runtime.dispatchSystemAction('learning.jobs', { scope: 'github:acme/api' })).toEqual([]);
    expect(await runtime.dispatchSystemAction('learning.capture', { scope: 'github:other/api', runId: 'degraded', eventRoot: join(homeDir, '.afk', 'events') }))
      .toMatchObject({ scanned: 0, blocked: [] });
    expect(await runtime.diagnostics('learning.distiller')).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'learning_capture_degraded' })]));
    await expect(runtime.dispatchSystemAction('learning.capture', { scope: 'github:acme/api', runId: 'degraded', eventRoot: '../private' })).rejects.toThrow();
    const healthy = { ...context, runId: 'healthy' };
    await observer.record(healthy, { kind: 'qa.started' });
    await observer.record(healthy, { kind: 'qa.passed' });
    await observer.record(healthy, { kind: 'run.finished', outcome: 'succeeded' });
    expect(await runtime.diagnostics('learning.distiller')).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'learning_capture_degraded' })]));
    const transcripts = join(homeDir, '.afk', 'transcripts');
    mkdirSync(transcripts, { recursive: true });
    const transcriptPath = join(transcripts, 'repaired.jsonl');
    writeFileSync(transcriptPath, '{"role":"user","content":"Review before publishing."}\n');
    await observer.record(context, { kind: 'agent.session_recorded', sessionId: 'outside', transcriptPath });
    expect(await runtime.diagnostics('learning.distiller')).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: 'learning_capture_degraded' })]));
  });

  it('clears global capture failures only for sources actually repaired by scoped reconciliation', async () => {
    const { runtime, homeDir } = await fixture({ enabled: true });
    const eventRoot = join(homeDir, '.afk', 'events');
    const transcripts = join(homeDir, '.afk', 'transcripts');
    mkdirSync(transcripts, { recursive: true });
    const events = new JsonlEventStore({ root: eventRoot });
    const scopes = ['github:acme/api', 'github:other/api'];
    for (const [index, scope] of scopes.entries()) {
      const runId = `limited-${index}`;
      const transcriptPath = join(transcripts, `${runId}.jsonl`);
      writeFileSync(transcriptPath, JSON.stringify({ role: 'user', content: 'x'.repeat(129 * 1024) }) + '\n');
      const data = [{ kind: 'qa.started' as const }, { kind: 'agent.session_recorded' as const, sessionId: runId, transcriptPath },
        { kind: 'qa.passed' as const }, { kind: 'run.finished' as const, outcome: 'succeeded' as const }];
      await events.append(data.map((entry, sequence) => ({ id: `${runId}-${sequence}`, schemaVersion: 1,
        type: entry.kind, occurredAt: new Date().toISOString(), correlationId: runId, data: entry,
        context: { traceId: runId, runId, workItemId: `${scope}#42`, profileId: 'local', attempt: 1,
          actor: { kind: 'system' as const, id: 'test' } } })));
    }
    expect(await runtime.dispatchSystemAction('learning.reconcile', { eventRoot })).toMatchObject({ blocked: [
      { runId: 'limited-0', code: 'source_limit' }, { runId: 'limited-1', code: 'source_limit' },
    ] });
    for (const [index, scope] of scopes.entries()) {
      writeFileSync(join(transcripts, `limited-${index}.jsonl`), '{"role":"user","content":"Require review."}\n');
      expect(await runtime.dispatchSystemAction('learning.reconcile', { scope, eventRoot })).toMatchObject({ scanned: 1, blocked: [] });
      const diagnostics = await runtime.diagnostics('learning.distiller');
      if (index === 0) expect(diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'learning_capture_degraded' })]));
      else expect(diagnostics).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: 'learning_capture_degraded' })]));
    }
  });

  it.each([false, true])('retains an unresolved source diagnostic during unfinished QA (previous capture: %s)', async previousCapture => {
    const { runtime, homeDir } = await fixture({ enabled: true });
    const eventRoot = join(homeDir, '.afk', 'events');
    const transcripts = join(homeDir, '.afk', 'transcripts');
    mkdirSync(transcripts, { recursive: true });
    const transcriptPath = join(transcripts, 'unfinished.jsonl');
    writeFileSync(transcriptPath, '{"role":"user","content":"Require review."}\n');
    const observer = createPluginRunObserver(runtime, eventRoot);
    const context = { traceId: 'unfinished', runId: 'unfinished', workItemId: 'github:acme/api#42', profileId: 'local', attempt: 1,
      actor: { kind: 'system' as const, id: 'test' } };
    if (!previousCapture) writeFileSync(transcriptPath, JSON.stringify({ role: 'user', content: 'x'.repeat(129 * 1024) }) + '\n');
    await observer.record(context, { kind: 'qa.started' });
    await observer.record(context, { kind: 'agent.session_recorded', sessionId: 'unfinished', transcriptPath });
    await observer.record(context, { kind: 'qa.passed' });
    await observer.record(context, { kind: 'run.finished', outcome: 'succeeded' });
    writeFileSync(transcriptPath, JSON.stringify({ role: 'user', content: 'x'.repeat(129 * 1024) }) + '\n');
    expect(await runtime.dispatchSystemAction('learning.reconcile', { eventRoot })).toMatchObject({ blocked: [
      { runId: 'unfinished', code: 'source_limit' },
    ] });
    await observer.record(context, { kind: 'qa.started' });
    expect(await runtime.dispatchSystemAction('learning.reconcile', { scope: 'github:acme/api', eventRoot }))
      .toMatchObject({ checkedSources: [], blocked: [] });
    expect(await runtime.diagnostics('learning.distiller')).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'learning_capture_degraded' })]));
  });

  it('does not recursively capture learning-purpose execution even when learning is enabled', async () => {
    const { runtime, homeDir } = await fixture({ enabled: true });
    await createPluginRunObserver(runtime, join(homeDir, '.afk', 'events')).record({ traceId: 't', runId: 'analysis', workItemId: 'github:acme/api#1',
      purpose: 'learning', profileId: 'local', attempt: 1, actor: { kind: 'system', id: 'test' } }, { kind: 'run.finished', outcome: 'succeeded' });
    expect(existsSync(join(homeDir, '.afk', 'learning', 'candidates.sqlite'))).toBe(false);
  });

  it('captures persisted managed execution into a real inbox and withdraws derived candidates after late failure', async () => {
    const { runtime, homeDir } = await fixture({ enabled: true });
    const eventRoot = join(homeDir, '.afk', 'events');
    const directory = join(homeDir, '.afk', 'learning');
    const transcriptPath = join(homeDir, '.afk', 'transcripts', 'session.jsonl');
    mkdirSync(join(homeDir, '.afk', 'transcripts'), { recursive: true });
    writeFileSync(transcriptPath, '{"role":"user","content":"Publishing requires a review."}\n');
    const observer = createPluginRunObserver(runtime, eventRoot);
    const context = { traceId: 't', runId: 'managed-1', workItemId: 'github:acme/api#42', profileId: 'local', attempt: 1,
      actor: { kind: 'system' as const, id: 'test' } };
    await observer.record(context, { kind: 'qa.started' });
    await observer.record(context, { kind: 'agent.session_recorded', sessionId: 'native-1', transcriptPath });
    await observer.record(context, { kind: 'qa.passed' });
    await observer.record(context, { kind: 'run.finished', outcome: 'succeeded' });
    expect(await runtime.dispatchSystemAction('learning.jobs', { scope: 'github:acme/api' })).toMatchObject([{ status: 'pending' }]);
    const store = new CandidateStore({ file: join(directory, 'candidates.sqlite') });
    const entry = store.listRequests()[0];
    store.close();
    const worker = new LearningWorker({ directory, enabled: true, provider: new ClaudeCodeProvider(), analyze: async () => ({ analysisRunId: 'fixture-analysis',
      output: { type: 'goal_complete', distillation: { version: 1, warnings: [], candidates: [{ kind: 'fact', title: 'Review', statement: 'Require review.',
        evidenceIds: [entry.evidence[0].id], applicability: { project: 'github:acme/api', environments: [], versions: [], preconditions: [], exclusions: [], invalidationConditions: [] },
        payload: { subject: 'publishing', rule: 'Require review', classification: 'proposal' } }] } } }) });
    try { expect((await worker.runOnce()).processed).toBe(1); } finally { await worker.close(); }
    expect(await runtime.dispatchSystemAction('learning.candidates', { scope: 'github:acme/api' })).toMatchObject([{ state: 'candidate' }]);
    await observer.record(context, { kind: 'qa.failed' });
    expect(await runtime.dispatchSystemAction('learning.candidates', { scope: 'github:acme/api' })).toMatchObject([{ state: 'conflict' }]);
  });

  it('keeps disabled learning out of the automatic audit path', async () => {
    const { runtime, homeDir } = await fixture();
    await createPluginRunObserver(runtime, join(homeDir, '.afk', 'events')).record({ traceId: 't', runId: 'r', workItemId: 'github:acme/api#1',
      profileId: 'local', attempt: 1, actor: { kind: 'system', id: 'test' } }, { kind: 'run.finished', outcome: 'succeeded' });
    expect(existsSync(join(homeDir, '.afk', 'learning', 'candidates.sqlite'))).toBe(false);
  });
  it('is discoverable and defaults to disabled without starting analysis', async () => {
    const { runtime, homeDir } = await fixture();
    expect(builtinPluginManifests(homeDir).find(manifest => manifest.id === 'learning.distiller')?.provides).toContain('workflow.action');
    expect(await runtime.dispatchSystemAction('learning.settings', {})).toMatchObject({ enabled: false, provider: 'claude-code' });
    await expect(runtime.dispatchSystemAction('learning.distill', {})).rejects.toThrow('learning_disabled');
    await expect(runtime.dispatchSystemAction('learning.worker.once', {})).rejects.toThrow('learning_disabled');
  });

  it('accepts typed evidence requests through the standard action and exposes scoped state', async () => {
    const { runtime, homeDir } = await fixture({ enabled: true });
    const file = join(homeDir, 'session.txt');
    writeFileSync(file, 'A policy requires approval.');
    const pack = await buildEvidencePack({ sources: [{ id: 'session-1', kind: 'journal', path: file, allowedRoot: homeDir, format: 'text' }] });
    const request = { version: 1, scope: 'github:acme/api', sourceId: 'session:one',
      evidenceDigest: pack.digest, analyzerVersion: '1', reason: 'import' };
    const accepted = await runtime.dispatchSystemAction('learning.distill', { request, pack });
    expect(accepted).toMatchObject({ request });
    expect(await runtime.dispatchSystemAction('learning.jobs', { scope: request.scope })).toMatchObject([{ status: 'pending' }]);
    expect(await runtime.dispatchSystemAction('learning.jobs', { scope: 'github:other/api' })).toEqual([]);
    await expect(runtime.dispatchSystemAction('learning.jobs', {})).rejects.toThrow();
    await expect(runtime.dispatchSystemAction('learning.distill', { request, pack, state: 'published' })).rejects.toThrow();
  });

  it('uses the existing configured plugin loader and rejects unknown configuration fields', async () => {
    const plugins = await createConfiguredPlugins({ configurations: [{ id: 'learning.distiller', config: { enabled: false, dailyCalls: 0 } }] });
    expect(plugins[0]?.manifest.id).toBe('learning.distiller');
    await expect(createConfiguredPlugins({ configurations: [{ id: 'learning.distiller', config: { dangerouslySkipPermissions: true } }] })).rejects.toThrow(/invalid configuration/i);
    expect(() => createLearningPlugin({ config: { dailyCalls: -1 } })).toThrow();
  });

  it('reports unsupported analysis providers rather than granting development permissions', async () => {
    const { runtime } = await fixture({ enabled: true, provider: 'cursor' });
    expect(await runtime.diagnostics('learning.distiller')).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'analysis_unsupported' })]));
    await expect(runtime.dispatchSystemAction('learning.worker.once', {})).rejects.toThrow('analysis_unsupported');
  });
});
