import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, constants, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import type { RunEventData } from '@afk/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import { TestRunnerVerificationProvider } from '../../infrastructure/verification/index.js';
import * as frozenVerification from '../../infrastructure/verification/frozen-command.js';
import { captureFrozenInput } from '../../infrastructure/sandbox/container/frozen-input.js';
import type { ContainerProvider } from '../../infrastructure/sandbox/container/types.js';
import * as storage from '../../infrastructure/storage/sqlite.js';
import type { VerificationProvider, VerificationRequest } from '../../plugin-sdk/capabilities.js';
import { CandidateStore } from './candidate-store.js';
import { DISTILLATION_LIMITS, type CandidateProposal } from './contracts.js';
import { buildEvidencePack } from './evidence.js';
import { reconcileDistillationSources } from './intake.js';
import { page, wikiScript } from './knowledge.fixture.spec.js';
import { KnowledgeContextProvider, prepareConfiguredKnowledge, publishConfiguredKnowledge, reconcileConfiguredKnowledge } from './knowledge-runtime.js';
import { canonicalLearningJson } from './requests.js';
import type { FactCommandCheckerConfiguration } from './validation-configuration.js';
import { validationConfigurationSchema, validateConfiguredLearningCandidate,
  type ValidationConfiguration, type ValidationProviderBinding, type ValidationRuntimeOptions } from './validation-runtime.js';

const scope = 'github:acme/api';
const bytesDigest = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(clean => clean()); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function fixture(kind: 'fact' | 'process' | 'lesson' = 'fact', managed = false, version?: string, project = scope, auditProject = project) {
  const scope = project;
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'validation-runtime-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'ledger', 'candidates.sqlite');
  const store = new CandidateStore({ file });
  cleanups.push(() => store.close());
  const auditRoot = join(root, 'audit');
  const events = new JsonlEventStore({ root: auditRoot });
  const transcripts = ['a-session', 'z-session', 'session-1'].map(session => join(root, '.afk', 'transcripts', `${session}.jsonl`));
  await events.append([{ id: 'event-1', schemaVersion: 1, type: 'agent.session_recorded', occurredAt: '2026-11-10T00:00:00Z',
    context: { runId: 'run-1', traceId: 'trace-1', workItemId: `${auditProject}#1`, profileId: 'default', attempt: 1,
      actor: { kind: 'system', id: 'fixture' } }, correlationId: 'run-1', data: { kind: 'agent.session_recorded', sessionId: 'session-1',
      ...(managed ? { transcriptPath: transcripts[2] } : {}) } }]);
  const auditPath = events.pathFor('run-1');
  if (managed) {
    vi.stubEnv('HOME', root);
    mkdirSync(dirname(transcripts[0]), { recursive: true });
    transcripts.forEach((path, index) => writeFileSync(path, JSON.stringify({ type: 'user', message: { content: `Business approval observation ${index}` } }) + '\n'));
    const data = [{ kind: 'qa.started' as const },
      { kind: 'agent.session_recorded' as const, sessionId: 'z-session', transcriptPath: transcripts[1] },
      { kind: 'agent.session_recorded' as const, sessionId: 'a-session', transcriptPath: transcripts[0] },
      { kind: 'qa.passed' as const }, { kind: 'run.finished' as const, outcome: 'succeeded' as const }];
    await events.append(data.map((entry, index) => ({ id: `managed-${index}`, schemaVersion: 1 as const, type: entry.kind,
      occurredAt: '2026-11-11T00:00:00Z', context: { runId: 'run-1', traceId: 'trace-1', workItemId: `${scope}#1`,
        profileId: 'default', attempt: 1, actor: { kind: 'system' as const, id: 'fixture' } }, correlationId: 'run-1', data: entry })));
    expect(await reconcileDistillationSources({ directory: dirname(file), eventRoot: auditRoot, homeDir: root })).toMatchObject({ submitted: 1, blocked: [] });
  }
  const audit = { id: 'audit-1', kind: 'audit' as const, path: auditPath, allowedRoot: auditRoot, runId: 'run-1' };
  const registered = managed ? store.listRequests()[0] : undefined;
  const pack = registered ? store.getEvidencePack(registered.request.evidenceDigest)! : await buildEvidencePack({ sources: [audit] });
  const refs = pack.entries.map(entry => entry.ref);
  const common = { title: 'Approval', statement: 'Approval precedes publication', evidenceIds: [refs[0].id],
    targetRef: 'wiki:approval', applicability: { project: scope, environments: [], versions: version ? [version] : [],
      preconditions: [], exclusions: [], invalidationConditions: [] } };
  const proposal: CandidateProposal = kind === 'fact'
    ? { ...common, kind, payload: { subject: 'release', rule: 'approval required', classification: 'fact' } }
    : kind === 'lesson' ? { ...common, kind, payload: { trigger: 'duplicate approval', rootCause: 'check then write race',
      rootCauseStatus: 'confirmed', attempts: ['retry without serialization'], fix: 'Serialize approval read and write',
      prevention: ['Run competing approval regression'] } }
    : { ...common, kind, payload: { entry: 'draft', systems: ['release-service'], preconditions: ['authenticated'],
      steps: [{ id: 'approve', action: 'approve', stateChange: 'draft -> approved', evidenceIds: [refs[0].id] },
        { id: 'publish', action: 'publish', stateChange: 'approved -> published', evidenceIds: [refs[0].id] }],
      exceptions: ['denied -> draft'], completion: 'published' } };
  const source = registered ?? store.submitRequest({ request: { version: 1, scope, sourceId: 'run:run-1', sourceRunId: 'run-1', workItemId: `${scope}#1`,
    evidenceDigest: pack.digest, analyzerVersion: 'fixture-1', reason: 'completed' }, evidence: refs }, pack);
  const candidateId = store.completeRequest(source.key, { version: 1, candidates: [proposal], warnings: [] }).candidateIds[0];
  const vault = join(root, 'vault');
  mkdirSync(vault);
  writeFileSync(join(vault, 'AGENTS.md'), '# Authorized test knowledge\n');
  writeFileSync(join(vault, 'template.md'), '# Template\n');
  const authorizationFile = join(root, 'knowledge-grant.json');
  const grant = { version: 1, revoked: false, allowWithdrawal: true, policy: { scope, vault,
    rules: { 'AGENTS.md': bytesDigest(readFileSync(join(vault, 'AGENTS.md'))), '.tools/wiki-lint.py': null },
    targets: [{ ref: 'wiki:approval', paths: ['Approval.md'], kinds: ['fact', 'process'], inbox: false,
      templatePath: 'template.md', indexPaths: ['index.md'], backlinkPaths: ['backlinks.md'] }] } };
  const persistGrant = () => writeFileSync(authorizationFile, JSON.stringify(grant), { mode: 0o600 });
  persistGrant();
  const targetRoot = join(root, 'business');
  mkdirSync(targetRoot);
  let targetRevision = 'a'.repeat(40);
  if (kind === 'lesson') {
    execFileSync('git', ['init', '--quiet', targetRoot]);
    execFileSync('git', ['-C', targetRoot, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(root, 'empty-hooks')}`, 'commit', '--quiet', '--allow-empty', '-m', 'QA fixture']);
    targetRevision = execFileSync('git', ['-C', targetRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  }
  const qaRunId = 'independent-qa';
  const appendQa = async (data: RunEventData[]) => events.append(data.map((entry, index) => ({ id: `qa-${index}-${entry.kind}`,
    schemaVersion: 1 as const, type: entry.kind, occurredAt: '2026-11-11T00:00:00Z',
    context: { runId: qaRunId, traceId: qaRunId, workItemId: `${scope}#1`, profileId: 'qa', attempt: 1,
      actor: { kind: 'system' as const, id: 'fixture' } }, correlationId: qaRunId, data: entry })));
  if (kind === 'lesson') await appendQa([{ kind: 'qa.started' }, { kind: 'decision.made', command: 'experience.qa-target', accepted: true,
    reason: JSON.stringify({ target: { project: scope, revision: targetRevision, dirty: false } }) },
  { kind: 'qa.passed' }, { kind: 'commit.recorded', phase: 'qa', branch: 'qa', commitSha: targetRevision },
  { kind: 'run.finished', outcome: 'succeeded' }]);
  const qaPath = events.pathFor(qaRunId);
  const targetPath = join(targetRoot, 'approval.json');
  const oracle = { subject: 'release', approvalRequired: true, entry: 'draft', systems: ['release-service'],
    preconditions: ['authenticated'], actions: ['approve', 'publish'], approvedState: 'approved', authority: [refs[0].locator],
    lesson: { trigger: 'duplicate approval', rootCause: 'check then write race', rootCauseStatus: 'confirmed',
      attempts: ['retry without serialization'], fix: 'Serialize approval read and write', prevention: ['Run competing approval regression'],
      project: scope, environments: [] as string[], versions: [] as string[], applicabilityPreconditions: [] as string[],
      exclusions: [] as string[], invalidationConditions: [] as string[],
      fixTargetRevision: targetRevision } };
  const persistOracle = () => writeFileSync(targetPath, JSON.stringify(oracle));
  persistOracle();
  const configurationFile = join(root, 'checkers.json');
  const config: ValidationConfiguration = { version: 1, checkers: [{ scope, checkerId: 'approval-policy', providerId: 'semantic-policy',
    version: '2026.11.1', authorizationFile, target: { ref: 'wiki:approval', root: targetRoot, path: 'approval.json' },
    ...(kind === 'lesson' ? { allowLessonValidation: true, qa: { scope, workItemId: `${scope}#1`, runId: qaRunId, targetRevision,
      root: auditRoot, auditDigest: bytesDigest(readFileSync(qaPath)) } } : {}),
    ...(managed ? {} : { evidence: [{ digest: pack.digest, sources: [audit] }] }) }] };
  const persistConfig = () => writeFileSync(configurationFile, JSON.stringify(config), { mode: 0o600 });
  persistConfig();
  let beforeVerify: (() => void | Promise<void>) | undefined;
  let duringVerify: (() => void | Promise<void>) | undefined;
  let doctorBinding = { scope, checkerId: 'approval-policy', providerId: 'semantic-policy', version: '2026.11.1' };
  const requests: VerificationRequest[] = [];
  const provider: VerificationProvider = { id: 'semantic-policy', capabilities: { 'test-execution': true, 'static-analysis': false, 'custom-script': false },
    doctor: vi.fn(async () => [{ check: 'learning-validation-v1', ok: true, detail: JSON.stringify(doctorBinding) }]),
    verify: vi.fn(async request => {
      requests.push(request);
      await beforeVerify?.();
      const policy = JSON.parse(readFileSync(targetPath, 'utf8'));
      const perform = (state: string, action: string, authorized: boolean): string => {
        if (!authorized) return state;
        if (state === 'draft' && action === 'approve') return policy.approvedState;
        if (state === 'approved' && action === 'publish') return 'published';
        return state;
      };
      let state = policy.entry;
      const values: Record<string, string | string[]> = { 'fact.subject': policy.subject,
        'fact.rule': policy.approvalRequired ? 'approval required' : 'no approval required', 'fact.authority': policy.authority,
        'process.entry': state, 'process.systems': policy.systems, 'process.preconditions': policy.preconditions,
        'process.stepCount': String(policy.actions.length),
        'process.applicability.preconditions': [], 'process.applicability.exclusions': [], 'process.applicability.invalidationConditions': [],
        'process.exceptions': [`denied -> ${perform('draft', 'approve', false)}`] };
      policy.actions.forEach((action: string, index: number) => {
        const previous = state;
        state = perform(state, action, true);
        values[`process.steps.${index}.action`] = action;
        values[`process.steps.${index}.stateChange`] = `${previous} -> ${state}`;
      });
      values['process.completion'] = state;
      for (const [field, value] of Object.entries(policy.lesson)) values[`lesson.${field}`] = value as string | string[];
      const envelope = JSON.parse(request.target);
      const assertions = envelope.assertions.map((assertion: { node: string }) => ({ ...assertion,
        actual: values[assertion.node], status: 'observed' }));
      await duringVerify?.();
      return { passed: true, durationMs: 1, output: JSON.stringify({ protocol: 'learning-validation-v1', binding: envelope.binding, assertions }) };
    }) };
  const bindings: ValidationProviderBinding[] = [];
  const options: ValidationRuntimeOptions = { file, configurationFile, resolveProvider: vi.fn(async binding => {
    bindings.push(binding);
    return provider;
  }) };
  const input = { scope, candidateId, expectedVersion: 1, checkerId: 'approval-policy' };
  return { root, store, input, options, candidateId, source, pack, auditPath, targetPath, config, grant, oracle, provider, requests, bindings,
    configurationFile, authorizationFile, persistConfig, persistGrant, persistOracle, transcripts, qaPath, appendQa,
    before: (callback: typeof beforeVerify) => { beforeVerify = callback; },
    during: (callback: typeof duringVerify) => { duringVerify = callback; },
    doctorIdentity: (change: Partial<typeof doctorBinding>) => { doctorBinding = { ...doctorBinding, ...change }; } };
}

const blocked = (code: string) => ({ status: 'blocked', code });

async function ownedFactCommandFixture(kind: 'fact' | 'process' = 'fact') {
  const setup = await fixture(kind);
  const checkerFile = join(setup.root, 'fact-checker.mjs');
  writeFileSync(checkerFile, `import { readFileSync } from 'node:fs';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const policy = JSON.parse(readFileSync('approval.json', 'utf8'));
const actual = { 'fact.subject': policy.subject,
  'fact.rule': policy.approvalRequired ? 'approval required' : 'no approval required', 'fact.authority': policy.authority };
process.stdout.write(JSON.stringify({ protocol: request.protocol, binding: request.binding,
  assertions: request.assertions.map(assertion => ({ ...assertion, actual: actual[assertion.node], status: 'observed' })) }));
`, { mode: 0o600 });
  const node = join(setup.root, 'node');
  copyFileSync(process.execPath, node, constants.COPYFILE_FICLONE);
  chmodSync(node, 0o700);
  const entry: FactCommandCheckerConfiguration = { ...setup.config.checkers[0], mode: 'fact-command', kind: 'fact',
    qa: undefined, allowLessonValidation: undefined,
    executionAuthorizationFile: join(setup.root, 'owned-fixture-execution-grant.json'),
    execution: { command: [node, checkerFile], timeoutMs: 2000,
      checkerFiles: [node, checkerFile].map(path => ({ path, digest: bytesDigest(readFileSync(path)) })),
      workspace: { kind: 'repository', providerId: 'owned-fixture-repository', id: 'owned-fixture-workspace',
        cwd: dirname(setup.targetPath), revision: 'owned-fixture-revision' } } };
  const persist = () => writeFileSync(setup.configurationFile, JSON.stringify({ version: 2, checkers: [entry] }), { mode: 0o600 });
  const executionGrant = { version: 1, purpose: 'fact-validation-execution', revoked: false, kind: 'fact', scope,
    checkerId: entry.checkerId, checkerVersion: entry.version,
    checkerDigest: bytesDigest(canonicalLearningJson(entry)), execution: entry.execution };
  const persistExecutionGrant = () => writeFileSync(entry.executionAuthorizationFile, JSON.stringify(executionGrant), { mode: 0o600 });
  persist(); persistExecutionGrant();
  const native = new TestRunnerVerificationProvider({ command: entry.execution.command });
  let state: 'active' | 'closed' = 'active';
  const leaseSnapshot = { workspace: structuredClone(entry.execution.workspace), leaseId: 'owned-fixture-lease', state };
  const lease = { readCommitSnapshot: vi.fn(() => ({ ...leaseSnapshot, state })),
    cleanup: vi.fn(async () => { state = 'closed'; return { closed: true as const }; }) };
  const provider = { id: entry.providerId, capabilities: native.capabilities, verify: vi.fn(native.verify.bind(native)) };
  const options: ValidationRuntimeOptions = { ...setup.options,
    resolveProvider: vi.fn(async () => provider),
    fact: { resolveWorkspace: vi.fn(async () => lease) } };
  return { ...setup, entry, checkerFile, persist, executionGrant, persistExecutionGrant, native, lease, leaseSnapshot, provider, options };
}

describe('frozen fact ownership bridge with no Docker allocation', () => {
  async function frozenFixture() {
    const setup = await ownedFactCommandFixture();
    const checkerRoot = join(setup.root, 'checker-package');
    mkdirSync(checkerRoot);
    writeFileSync(join(checkerRoot, 'checker.mjs'), 'process.stdout.write("inert fixture");');
    setup.entry.execution = { ...setup.entry.execution, checkerFiles: [],
      command: ['/usr/local/bin/node', '/workspace/checker.mjs', '/workspace/.verification-request.json', '/workspace/.verification-target.json'],
      frozen: { checkerRoot, checkerDigest: captureFrozenInput(checkerRoot).digest, baseImageId: `sha256:${'a'.repeat(64)}` } };
    setup.executionGrant.execution = setup.entry.execution;
    setup.executionGrant.checkerDigest = bytesDigest(canonicalLearningJson(setup.entry));
    setup.persist(); setup.persistExecutionGrant();
    setup.options.frozen = {};
    const allocations: unknown[] = [];
    const build = vi.fn(async () => {
      const reader = new CandidateStore({ file: setup.options.file });
      try { allocations.push(reader.listFactOwnership(scope)); } finally { reader.close(); }
      throw new Error('inert allocation boundary reached');
    });
    const cleanup = vi.fn(async () => undefined);
    const engine = { engine: 'docker', binary: 'inert', frozen: {
      buildFrozenImage: build, cleanupFrozenOperation: cleanup,
    } } as unknown as ContainerProvider;
    let beforeOwnership: (() => void) | undefined;
    vi.spyOn(frozenVerification, 'executeNativeFrozenVerification').mockImplementation(async (request, options) => {
      beforeOwnership?.();
      await frozenVerification.executeFrozenVerification(engine, request, options);
      throw new Error('inert engine cannot grant native identity');
    });
    return { ...setup, allocations, build, cleanup, beforeOwnership: (callback: () => void) => { beforeOwnership = callback; } };
  }

  it('commits exact ownership in SQLite before the allocation boundary without validating a candidate', async () => {
    const setup = await frozenFixture();
    const result = await validateConfiguredLearningCandidate(setup.input, setup.options);
    expect(result.status).toBe('blocked');
    expect(setup.build).toHaveBeenCalledTimes(1);
    const records = setup.store.listFactOwnership(scope);
    expect(records).toHaveLength(1);
    expect(setup.allocations).toEqual([records]);
    expect(records[0]).toMatchObject({
      binding: { scope, candidateId: setup.candidateId, candidateVersion: 1, evidenceDigest: setup.pack.digest },
      check: { checkerId: setup.input.checkerId, checkerVersion: setup.entry.version,
        checkerDigest: setup.entry.execution.frozen!.checkerDigest,
        targetDigest: bytesDigest(readFileSync(setup.targetPath)), workspace: setup.entry.execution.workspace, leaseId: 'owned-fixture-lease' },
    });
    expect(records[0].check.requestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(setup.store.getCandidate(setup.candidateId)?.state).toBe('candidate');
    expect(setup.lease.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each(['grant', 'target', 'source'] as const)('rejects changed %s before committing ownership or allocating', async change => {
    const setup = await frozenFixture();
    setup.beforeOwnership(() => {
      if (change === 'grant') { setup.executionGrant.revoked = true; setup.persistExecutionGrant(); }
      else if (change === 'target') writeFileSync(setup.targetPath, '{}');
      else writeFileSync(setup.auditPath, '{}\n');
    });
    expect((await validateConfiguredLearningCandidate(setup.input, setup.options)).status).toBe('blocked');
    expect(setup.build).not.toHaveBeenCalled();
    expect(setup.store.listFactOwnership(scope)).toEqual([]);
    expect(setup.store.getCandidate(setup.candidateId)?.state).toBe('candidate');
  });

  it.each(['revoked', 'cancelled', 'hook-failed'] as const)('retains the journal but prevents allocation after %s', async change => {
    const setup = await frozenFixture();
    const controller = new AbortController();
    setup.options = { ...setup.options, signal: controller.signal };
    setup.options.frozen = { onOwnership: async ownership => {
      expect(setup.store.getFactOwnership(ownership.operationId)).toBeDefined();
      if (change === 'revoked') { setup.executionGrant.revoked = true; setup.persistExecutionGrant(); }
      else if (change === 'cancelled') controller.abort();
      else throw new Error('ownership observer failed');
    } };
    expect((await validateConfiguredLearningCandidate(setup.input, setup.options)).status).toBe('blocked');
    expect(setup.build).not.toHaveBeenCalled();
    expect(setup.store.listFactOwnership(scope)).toHaveLength(1);
    expect(setup.store.getCandidate(setup.candidateId)?.state).toBe('candidate');
  });

  it.each(['matching', 'missing', 'operation', 'execution', 'request', 'checker', 'target', 'image', 'input', 'context'] as const)(
    'binds a returned %s frozen receipt to the durable allocation record without granting native identity', async defect => {
      const setup = await frozenFixture();
      vi.mocked(frozenVerification.executeNativeFrozenVerification).mockImplementation(async (request, options) => {
        const operationId = randomUUID();
        const ownership = { operationId, engine: 'docker' as const, containerName: `afk-frozen-${operationId}`,
          baseImageId: request.baseImageId, inputDigest: 'c'.repeat(64), contextDigest: 'd'.repeat(64) };
        if (defect !== 'missing') await options.onOwnership(ownership);
        return { protocol: 'verification-execution-v1', executionId: defect === 'execution' ? 'different-execution' : request.executionId,
          command: request.command, cwd: '/workspace', inputDigest: defect === 'request' ? 'e'.repeat(64) : bytesDigest(request.input),
          exitCode: 0, stdout: '{}', stderr: '', closed: true,
          frozen: { checkerDigest: defect === 'checker' ? 'e'.repeat(64) : request.checkerDigest,
            baseImageId: defect === 'image' ? `sha256:${'e'.repeat(64)}` : request.baseImageId,
            targetDigest: defect === 'target' ? 'e'.repeat(64) : request.target.digest,
            operationId: defect === 'operation' ? randomUUID() : operationId, containerId: 'a'.repeat(64), imageId: `sha256:${'b'.repeat(64)}`,
            inputDigest: defect === 'input' ? 'e'.repeat(64) : ownership.inputDigest,
            contextDigest: defect === 'context' ? 'e'.repeat(64) : ownership.contextDigest,
            commandDigest: 'c'.repeat(64), policyDigest: 'd'.repeat(64), containerRemoved: true, imageRemoved: true } };
      });
      expect(await validateConfiguredLearningCandidate(setup.input, setup.options))
        .toEqual(blocked(defect === 'matching' ? 'invalid_execution' : 'verification_failed'));
      expect(setup.build).not.toHaveBeenCalled();
      expect(setup.store.listFactOwnership(scope)).toHaveLength(defect === 'missing' ? 0 : 1);
      expect(setup.store.getCandidate(setup.candidateId)?.state).toBe('candidate');
      expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
      expect(setup.lease.cleanup).toHaveBeenCalledTimes(1);
    });
});

describe('fact command bridge with owned fixtures, not domain qualification', () => {
  it('runs an independently reading native Node checker with cwd separate from semantic stdin and persists host proof', async () => {
    const setup = await ownedFactCommandFixture();
    const result = await validateConfiguredLearningCandidate(setup.input, setup.options);
    expect(result.status).toBe('validated');
    expect(setup.lease.cleanup).toHaveBeenCalledTimes(1);
    expect(setup.options.fact!.resolveWorkspace).toHaveBeenCalledWith(setup.entry.execution.workspace, expect.anything());
    const receipt = setup.store.getValidation(setup.candidateId)!;
    const audit = JSON.parse(Buffer.from(receipt.results.map(chunk => chunk.slice('json-base64-v1:'.length)).join(''), 'base64').toString());
    expect(audit.execution).toMatchObject({ protocol: 'verification-execution-v1', executionId: result.status === 'validated' ? result.executionId : '',
      cwd: setup.entry.execution.workspace.cwd, command: setup.entry.execution.command, exitCode: 0, closed: true });
    expect(audit.cleanup).toEqual({ closed: true });
    expect(audit.report.binding.execution).toMatchObject({ leaseId: 'owned-fixture-lease', workspaceRevision: 'owned-fixture-revision' });
    expect(audit.receiptDigest).toBe(bytesDigest(canonicalLearningJson({ report: audit.report, execution: audit.execution, cleanup: audit.cleanup })));
  });

  it('blocks the production entry until a usable selected workspace lease is supplied', async () => {
    const setup = await ownedFactCommandFixture();
    delete setup.options.fact;
    expect(await validateConfiguredLearningCandidate(setup.input, setup.options)).toEqual(blocked('checker_unavailable'));
    expect(setup.options.resolveProvider).not.toHaveBeenCalled();
    expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
  });

  it('rejects a group-writable executable even when its digest matches the grant', async () => {
    const setup = await ownedFactCommandFixture();
    chmodSync(setup.entry.execution.command[0], 0o770);
    expect(await validateConfiguredLearningCandidate(setup.input, setup.options)).toEqual(blocked('unauthorized'));
    expect(setup.options.resolveProvider).not.toHaveBeenCalled();
    expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
  });

  it.each(['missing', 'publication', 'revoked', 'command', 'checker', 'workspace'] as const)('refuses %s independent execution authority before dispatch', async defect => {
    const setup = await ownedFactCommandFixture();
    if (defect === 'missing') rmSync(setup.entry.executionAuthorizationFile);
    if (defect === 'publication') writeFileSync(setup.entry.executionAuthorizationFile, JSON.stringify(setup.grant));
    if (defect === 'revoked') { setup.executionGrant.revoked = true; setup.persistExecutionGrant(); }
    if (defect === 'command') { setup.executionGrant.execution.command = [realpathSync(process.execPath), '-e', 'process.exit(0)']; setup.persistExecutionGrant(); }
    if (defect === 'checker') { setup.executionGrant.checkerDigest = 'a'.repeat(64); setup.persistExecutionGrant(); }
    if (defect === 'workspace') { setup.executionGrant.execution.workspace.id = 'other'; setup.persistExecutionGrant(); }
    expect((await validateConfiguredLearningCandidate(setup.input, setup.options)).status).toBe('blocked');
    expect(setup.options.resolveProvider).not.toHaveBeenCalled();
    expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
  });

  it.each(['process', 'checker-bytes', 'workspace', 'lease', 'cleanup', 'semantic'] as const)('fails closed for %s without issuing a receipt', async defect => {
    const setup = await ownedFactCommandFixture(defect === 'process' ? 'process' : 'fact');
    if (defect === 'checker-bytes') writeFileSync(setup.checkerFile, 'process.exit(0)');
    if (defect === 'workspace') setup.leaseSnapshot.workspace.cwd = setup.root;
    if (defect === 'lease') setup.lease.readCommitSnapshot.mockImplementation(() => ({ ...setup.leaseSnapshot, state: 'closed' }));
    if (defect === 'cleanup') setup.lease.cleanup.mockRejectedValue(new Error('fixture cleanup failed'));
    if (defect === 'semantic') { setup.oracle.subject = 'other entity'; setup.persistOracle(); }
    expect((await validateConfiguredLearningCandidate(setup.input, setup.options)).status).toBe('blocked');
    expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
    expect(setup.store.getCandidate(setup.candidateId)?.state).toBe('candidate');
  });

  it.each(['configuration', 'execution-grant', 'publication-grant', 'checker', 'source', 'target', 'workspace', 'lease', 'cancel'] as const)(
    'rereads %s under the existing ledger write lock', async defect => {
      const setup = await ownedFactCommandFixture();
      const controller = new AbortController();
      setup.options = { ...setup.options, signal: controller.signal };
      const changed = () => {
        if (defect === 'configuration') { setup.entry.version = 'v2'; setup.persist(); }
        if (defect === 'execution-grant') { setup.executionGrant.revoked = true; setup.persistExecutionGrant(); }
        if (defect === 'publication-grant') { setup.grant.revoked = true; setup.persistGrant(); }
        if (defect === 'checker') writeFileSync(setup.checkerFile, 'process.exit(0)');
        if (defect === 'source') writeFileSync(setup.auditPath, readFileSync(setup.auditPath, 'utf8') + '\n');
        if (defect === 'target') { setup.oracle.subject = 'changed'; setup.persistOracle(); }
        if (defect === 'workspace') setup.leaseSnapshot.workspace.revision = 'changed';
        if (defect === 'lease') setup.leaseSnapshot.leaseId = 'changed';
        if (defect === 'cancel') controller.abort();
      };
      const write = storage.openSqlite;
      const opening = vi.spyOn(storage, 'openSqlite').mockImplementation((...args) => {
        const database = write(...args);
        const exec = database.exec.bind(database);
        vi.spyOn(database, 'exec').mockImplementation(sql => {
          exec(sql);
          if (sql === 'BEGIN IMMEDIATE' && setup.lease.cleanup.mock.calls.length > 0) changed();
        });
        return database;
      });
      try {
        expect((await validateConfiguredLearningCandidate(setup.input, setup.options)).status).toBe('blocked');
        expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
      } finally { opening.mockRestore(); }
    });

  it('does not replace native stdout with the outer generic output', async () => {
    const setup = await ownedFactCommandFixture();
    const run = setup.provider.verify.getMockImplementation()!;
    setup.provider.verify.mockImplementation(async (...args) => ({ ...await run(...args), output: 'ordinary runner text' }));
    expect((await validateConfiguredLearningCandidate(setup.input, setup.options)).status).toBe('validated');
  });

  it('rejects a copied native execution observation even when its fields match', async () => {
    const setup = await ownedFactCommandFixture();
    const run = setup.provider.verify.getMockImplementation()!;
    setup.provider.verify.mockImplementation(async (...args) => {
      const result = await run(...args);
      return { ...result, execution: result.execution && { ...result.execution } };
    });
    expect(await validateConfiguredLearningCandidate(setup.input, setup.options)).toEqual(blocked('invalid_execution'));
    expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
    expect(setup.store.getCandidate(setup.candidateId)?.state).toBe('candidate');
  });

  it.each(['missing', 'injected'] as const)('refuses %s host observations from a generic command adapter', async defect => {
    const setup = await ownedFactCommandFixture();
    if (defect === 'missing') setup.provider.verify.mockResolvedValue({ passed: true, durationMs: 0, output: '{}' });
    else {
      const injected = new TestRunnerVerificationProvider({ command: setup.entry.execution.command,
        runner: async () => ({ exitCode: 0, stdout: '{}', stderr: '' }) });
      setup.provider.verify.mockImplementation(injected.verify.bind(injected));
    }
    expect(await validateConfiguredLearningCandidate(setup.input, setup.options)).toEqual(blocked('invalid_execution'));
    expect(setup.lease.cleanup).toHaveBeenCalledTimes(1);
    expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
  });

  it('does not wait forever for failed-path cleanup after cancellation', async () => {
    const setup = await ownedFactCommandFixture();
    const controller = new AbortController();
    setup.options = { ...setup.options, signal: controller.signal };
    setup.provider.verify.mockImplementation(async () => {
      controller.abort();
      return { passed: true, durationMs: 0 };
    });
    setup.lease.cleanup.mockImplementation(() => new Promise(() => undefined));
    const completed = await Promise.race([
      validateConfiguredLearningCandidate(setup.input, setup.options),
      new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), 2500)),
    ]);
    expect(completed).toEqual(blocked('cancelled'));
    expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
  });

  it('releases a cancelled native execution lease only after the verification call settles', async () => {
    const setup = await ownedFactCommandFixture();
    const controller = new AbortController();
    setup.options = { ...setup.options, signal: controller.signal };
    const run = setup.provider.verify.getMockImplementation()!;
    let settled = false;
    let releasedBeforeSettlement = false;
    setup.provider.verify.mockImplementation(async (...args) => {
      const timer = setTimeout(() => controller.abort(), 1);
      try { return await run(...args); }
      finally { settled = true; clearTimeout(timer); }
    });
    const cleanup = setup.lease.cleanup.getMockImplementation()!;
    setup.lease.cleanup.mockImplementation(async () => { releasedBeforeSettlement = !settled; return cleanup(); });
    expect(await validateConfiguredLearningCandidate(setup.input, setup.options)).toEqual(blocked('cancelled'));
    await vi.waitFor(() => expect(setup.lease.cleanup).toHaveBeenCalledTimes(1));
    expect(releasedBeforeSettlement).toBe(false);
    expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
  });

  it('cleans a lease returned after cancellation without accepting late success', async () => {
    const setup = await ownedFactCommandFixture();
    const controller = new AbortController();
    setup.options = { ...setup.options, signal: controller.signal };
    let release: () => void = () => undefined;
    setup.options.fact!.resolveWorkspace = async () => {
      controller.abort();
      await new Promise<void>(resolve => { release = resolve; });
      return setup.lease;
    };
    expect(await validateConfiguredLearningCandidate(setup.input, setup.options)).toEqual(blocked('cancelled'));
    release();
    await vi.waitFor(() => expect(setup.lease.cleanup).toHaveBeenCalledTimes(1));
    expect(setup.options.resolveProvider).not.toHaveBeenCalled();
    expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
  });

  it('returns the committed result when cancellation arrives after the validation transaction commits', async () => {
    const setup = await ownedFactCommandFixture();
    const controller = new AbortController();
    setup.options = { ...setup.options, signal: controller.signal };
    const open = storage.openSqlite;
    const opening = vi.spyOn(storage, 'openSqlite').mockImplementation((...args) => {
      const database = open(...args);
      const exec = database.exec.bind(database);
      vi.spyOn(database, 'exec').mockImplementation(sql => {
        exec(sql);
        if (sql === 'COMMIT' && setup.lease.cleanup.mock.calls.length > 0) controller.abort();
      });
      return database;
    });
    try {
      expect((await validateConfiguredLearningCandidate(setup.input, setup.options)).status).toBe('validated');
      expect(setup.store.getValidation(setup.candidateId)?.passed).toBe(true);
    } finally { opening.mockRestore(); }
  });
});

async function holdOpeningLock(file: string) {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(workerData.file);
    database.exec('BEGIN IMMEDIATE');
    parentPort.postMessage('locked');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    database.exec('COMMIT');
    database.close();
  `, { eval: true, workerData: { file } });
  cleanups.push(() => { void worker.terminate(); });
  await new Promise<void>((resolve, reject) => { worker.once('message', () => resolve()); worker.once('error', reject); });
}

describe('persisted learning validation runtime', () => {
  it.each(['fact', 'process', 'lesson'] as const)('preserves independent %s validation through saved v2 knowledge configuration', async kind => {
    const setup = await fixture(kind);
    writeFileSync(setup.configurationFile, JSON.stringify({ version: 2,
      checkers: setup.config.checkers.map(entry => ({ ...entry, mode: 'knowledge' })) }), { mode: 0o600 });
    const result = await validateConfiguredLearningCandidate(setup.input, setup.options);
    expect(result.status).toBe('validated');
    expect(setup.provider.verify).toHaveBeenCalledTimes(1);
    expect(setup.bindings[0]).toMatchObject({ scope, checkerId: setup.input.checkerId, providerId: 'semantic-policy' });
  });

  it('validates a lesson only with saved independent QA and independent semantic observations', async () => {
    const setup = await fixture('lesson');
    const result = await validateConfiguredLearningCandidate(setup.input, setup.options);
    expect(result.status).toBe('validated');
    const envelope = JSON.parse(setup.requests[0].target);
    expect(envelope.binding.qa).toMatchObject({ scope, workItemId: `${scope}#1`, qaRunId: 'independent-qa',
      targetRevision: setup.config.checkers[0].qa!.targetRevision, auditSequence: 5 });
    expect(envelope.binding.qaEvidence).toHaveLength(5);
    expect(envelope.binding.target.revision).toMatch(/^sha256:/);
    expect(envelope.binding.target.revision).not.toBe(envelope.binding.qa.targetRevision);
    expect(envelope.assertions.map((entry: { node: string }) => entry.node)).toEqual(expect.arrayContaining([
      'lesson.trigger', 'lesson.rootCause', 'lesson.rootCauseStatus', 'lesson.attempts', 'lesson.fix', 'lesson.prevention',
      'lesson.project', 'lesson.environments', 'lesson.versions', 'lesson.applicabilityPreconditions', 'lesson.exclusions',
      'lesson.invalidationConditions', 'lesson.fixTargetRevision',
    ]));
    const receipt = setup.store.getValidation(setup.candidateId)!;
    expect(receipt.passed).toBe(true);
    expect(setup.store.getCandidate(setup.candidateId)?.version).toBe(2);
  });

  it.each(['rootCause', 'fix', 'prevention', 'fixTargetRevision', 'exclusions'] as const)('rejects false lesson %s despite actual QA passing', async field => {
    const setup = await fixture('lesson');
    if (field === 'prevention' || field === 'exclusions') setup.oracle.lesson[field] = ['different observed constraint'];
    else setup.oracle.lesson[field] = 'different observed fact';
    setup.persistOracle();
    expect(await validateConfiguredLearningCandidate(setup.input, setup.options)).toEqual(blocked('assertion_failed'));
    expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
    expect(setup.store.getCandidate(setup.candidateId)?.version).toBe(1);
  });

  it('blocks an unconfigured QA prerequisite before semantic execution', async () => {
    const setup = await fixture('lesson');
    delete setup.config.checkers[0].qa;
    setup.persistConfig();
    expect(await validateConfiguredLearningCandidate(setup.input, setup.options)).toEqual(blocked('qa_unconfigured'));
    expect(setup.provider.verify).not.toHaveBeenCalled();
    expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
  });

  it.each([undefined, false])('requires explicit private lesson validation permission (%s)', async allowed => {
    const setup = await fixture('lesson');
    setup.config.checkers[0].allowLessonValidation = allowed;
    setup.persistConfig();
    expect(await validateConfiguredLearningCandidate(setup.input, setup.options)).toEqual(blocked('unauthorized'));
    expect(setup.provider.verify).not.toHaveBeenCalled();
    expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
  });

  it.each(['qa', 'passed', 'binding', 'allowLessonValidation'])('rejects caller supplied %s before reading private configuration', async key => {
    const setup = await fixture('lesson');
    expect(await validateConfiguredLearningCandidate({ ...setup.input, [key]: setup.config.checkers[0].qa }, setup.options))
      .toEqual(blocked('invalid_input'));
    expect(setup.options.resolveProvider).not.toHaveBeenCalled();
  });

  it('rejects a hash-valid late QA invalidation during semantic execution', async () => {
    const setup = await fixture('lesson');
    setup.during(async () => { await setup.appendQa([{ kind: 'qa.failed' }]); });
    expect(await validateConfiguredLearningCandidate(setup.input, setup.options)).toEqual(blocked('audit_changed'));
    expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
  });

  it('blocks a missing semantic checker even with verified QA', async () => {
    const setup = await fixture('lesson');
    setup.provider.doctor = undefined;
    expect(await validateConfiguredLearningCandidate(setup.input, setup.options)).toEqual(blocked('checker_unavailable'));
    expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
  });

  it('does not validate a lesson after null-reason cancellation during semantic execution', async () => {
    const setup = await fixture('lesson');
    const controller = new AbortController();
    setup.during(() => { controller.abort(null); });
    expect(await validateConfiguredLearningCandidate(setup.input, { ...setup.options, signal: controller.signal })).toEqual(blocked('cancelled'));
    expect(setup.store.getCandidate(setup.candidateId)?.version).toBe(1);
    expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
  });

  it.each(['qa', 'qa-missing', 'qa-symlink', 'config', 'permission', 'grant', 'source', 'target', 'unchanged'] as const)
    ('checks current lesson %s under the actual SQLite write lock', async changed => {
      const setup = await fixture('lesson');
      const originalAudit = readFileSync(setup.qaPath);
      await setup.appendQa([{ kind: 'qa.failed' }]);
      const invalidatedAudit = readFileSync(setup.qaPath);
      writeFileSync(setup.qaPath, originalAudit);
      const configuration = structuredClone(setup.config);
      if (changed === 'permission') configuration.checkers[0].allowLessonValidation = false;
      else configuration.checkers[0].qa!.targetRevision = 'b'.repeat(40);
      const mutations = {
        qa: { path: setup.qaPath, content: invalidatedAudit },
        config: { path: setup.configurationFile, content: JSON.stringify(configuration) },
        permission: { path: setup.configurationFile, content: JSON.stringify(configuration) },
        grant: { path: setup.authorizationFile, content: JSON.stringify({ ...setup.grant, revoked: true }) },
        source: { path: setup.auditPath, content: 'changed source during write lock wait' },
        target: { path: setup.targetPath, content: JSON.stringify({ ...setup.oracle, lesson: { ...setup.oracle.lesson, rootCause: 'unrelated cause' } }) },
      };
      const alias = join(setup.root, 'qa-alias.jsonl');
      writeFileSync(alias, originalAudit);
      const coordination = new SharedArrayBuffer(12);
      const state = new Int32Array(coordination);
      const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        const { DatabaseSync } = require('node:sqlite');
        const { writeFileSync, rmSync, symlinkSync } = require('node:fs');
        const database = new DatabaseSync(workerData.file);
        const state = new Int32Array(workerData.coordination);
        parentPort.postMessage('ready');
        Atomics.wait(state, 0, 0);
        database.exec('BEGIN IMMEDIATE');
        Atomics.store(state, 1, 1);
        Atomics.notify(state, 1);
        Atomics.wait(state, 0, 1, 70);
        if (workerData.mutation) writeFileSync(workerData.mutation.path, workerData.mutation.content);
        if (workerData.changed === 'qa-missing') rmSync(workerData.qaPath);
        if (workerData.changed === 'qa-symlink') {
          rmSync(workerData.qaPath);
          symlinkSync(workerData.alias, workerData.qaPath);
        }
        Atomics.store(state, 2, 1);
        Atomics.wait(state, 0, 1, 100);
        database.exec('COMMIT');
        database.close();
      `, { eval: true, workerData: { file: setup.options.file, coordination, changed, qaPath: setup.qaPath, alias,
        mutation: changed === 'unchanged' || changed === 'qa-missing' || changed === 'qa-symlink' ? undefined : mutations[changed] } });
      cleanups.push(() => { void worker.terminate(); });
      await new Promise<void>((resolve, reject) => { worker.once('message', () => resolve()); worker.once('error', reject); });
      const recordValidation = CandidateStore.prototype.recordValidation;
      const record = vi.spyOn(CandidateStore.prototype, 'recordValidation').mockImplementation(function (this: CandidateStore, ...args) {
        Atomics.store(state, 0, 1);
        Atomics.notify(state, 0);
        if (Atomics.wait(state, 1, 0, 1000) === 'timed-out') throw new Error('writer lock not acquired');
        return recordValidation.apply(this, args);
      });
      try {
        const result = await validateConfiguredLearningCandidate(setup.input, { ...setup.options, timeoutMs: 2000 });
        expect(record).toHaveBeenCalledTimes(1);
        expect(Atomics.load(state, 2)).toBe(1);
        if (changed === 'unchanged') expect(result.status).toBe('validated');
        else {
          expect(result.status).toBe('blocked');
          expect(result).not.toEqual(blocked('timed_out'));
          if (changed === 'qa') expect(result).toEqual(blocked('audit_changed'));
          if (changed === 'qa-missing' || changed === 'qa-symlink') expect(result).toEqual(blocked('commit_guard_unavailable'));
          expect(JSON.stringify(result)).not.toContain(setup.root);
          expect(setup.store.getCandidate(setup.candidateId)?.version).toBe(1);
          expect(setup.store.getCandidateVersions(setup.candidateId)).toHaveLength(1);
          expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
        }
      } finally { record.mockRestore(); }
    });

  it.each(['scope', 'workItemId', 'runId', 'targetRevision', 'auditDigest', 'root'] as const)
    ('rejects an invalid saved QA %s before semantic verification', async field => {
      const setup = await fixture('lesson');
      const qa = setup.config.checkers[0].qa!;
      if (field === 'scope') qa.scope = 'github:other/repository';
      if (field === 'workItemId') qa.workItemId = `${scope}#2`;
      if (field === 'runId') qa.runId = 'run-1';
      if (field === 'targetRevision') qa.targetRevision = 'b'.repeat(40);
      if (field === 'auditDigest') qa.auditDigest = '0'.repeat(64);
      if (field === 'root') qa.root = join(setup.root, 'missing');
      setup.persistConfig();
      const result = await validateConfiguredLearningCandidate(setup.input, setup.options);
      expect(result.status).toBe('blocked');
      expect(setup.provider.verify).not.toHaveBeenCalled();
      expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
    });

  it.each([NaN, 0, -1, Infinity, -Infinity, DISTILLATION_LIMITS.timeoutMs + 1, 1.5, '100', null])('rejects invalid timeout %s before opening the ledger or resolving a checker', async timeoutMs => {
    const setup = await fixture();
    const open = vi.spyOn(storage, 'openSqlite');
    const file = vi.fn(() => setup.options.file);
    const configurationFile = vi.fn(() => setup.options.configurationFile);
    const options = { ...setup.options, timeoutMs: timeoutMs as number };
    Object.defineProperties(options, { file: { get: file }, configurationFile: { get: configurationFile } });
    try {
      expect(await validateConfiguredLearningCandidate(setup.input, options)).toEqual(blocked('invalid_input'));
      expect(file).not.toHaveBeenCalled();
      expect(configurationFile).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(setup.options.resolveProvider).not.toHaveBeenCalled();
      expect(setup.provider.verify).not.toHaveBeenCalled();
      expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
    } finally { open.mockRestore(); }
  });

  it.each([undefined, DISTILLATION_LIMITS.timeoutMs])('preserves a valid default or maximum timeout (%s)', async timeoutMs => {
    const setup = await fixture();
    expect((await validateConfiguredLearningCandidate(setup.input, { ...setup.options, timeoutMs })).status).toBe('validated');
    expect(setup.requests[0].timeoutMs).toBeGreaterThan(0);
    expect(setup.requests[0].timeoutMs).toBeLessThanOrEqual(DISTILLATION_LIMITS.timeoutMs);
  });

  it('rounds a fractional remaining budget down before forwarding it to the core', async () => {
    const setup = await fixture();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000.75).mockReturnValueOnce(1000.25);
    try {
      expect((await validateConfiguredLearningCandidate(setup.input, { ...setup.options, timeoutMs: 100 })).status).toBe('validated');
      expect(setup.requests[0].timeoutMs).toBe(99);
    } finally { clock.mockRestore(); }
  });

  it('refuses a sub-millisecond remainder instead of rounding it up into a new budget', async () => {
    const setup = await fixture();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1099.75).mockReturnValueOnce(1000.25);
    try {
      expect(await validateConfiguredLearningCandidate(setup.input, { ...setup.options, timeoutMs: 100 })).toEqual(blocked('timed_out'));
      expect(setup.options.resolveProvider).not.toHaveBeenCalled();
      expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
    } finally { clock.mockRestore(); }
  });

  it.each([false, true])('counts a real ledger-opening writer wait against the entry deadline (managed=%s)', async managed => {
    const setup = await fixture('fact', managed);
    await holdOpeningLock(setup.options.file);
    const began = performance.now();
    expect(await validateConfiguredLearningCandidate(setup.input, { ...setup.options, timeoutMs: 100 })).toEqual(blocked('timed_out'));
    expect(performance.now() - began).toBeGreaterThan(200);
    expect(setup.options.resolveProvider).not.toHaveBeenCalled();
    expect(setup.provider.verify).not.toHaveBeenCalled();
    expect(setup.store.getCandidate(setup.candidateId)?.state).toBe('candidate');
    expect(setup.store.getCandidateVersions(setup.candidateId)).toHaveLength(1);
    expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
    const reopened = new CandidateStore({ file: setup.options.file });
    try {
      expect(reopened.getCandidate(setup.candidateId)?.state).toBe('candidate');
      expect(reopened.getValidation(setup.candidateId)).toBeUndefined();
    } finally { reopened.close(); }
  });

  it.each([false, true])('passes only the remaining budget after a within-budget real opening wait (managed=%s)', async managed => {
    const setup = await fixture('fact', managed);
    await holdOpeningLock(setup.options.file);
    expect((await validateConfiguredLearningCandidate(setup.input, { ...setup.options, timeoutMs: 1500 })).status).toBe('validated');
    expect(Number.isInteger(setup.requests[0].timeoutMs)).toBe(true);
    expect(setup.requests[0].timeoutMs).toBeGreaterThan(0);
    expect(setup.requests[0].timeoutMs).toBeLessThan(1300);
  });

  it.each([false, true])('does not restart the budget after opening and asynchronous provider resolution (managed=%s)', async managed => {
    const setup = await fixture('fact', managed);
    await holdOpeningLock(setup.options.file);
    vi.mocked(setup.options.resolveProvider).mockImplementation(async () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      return setup.provider;
    });
    const began = performance.now();
    expect(await validateConfiguredLearningCandidate(setup.input, { ...setup.options, timeoutMs: 450 })).toEqual(blocked('timed_out'));
    expect(performance.now() - began).toBeGreaterThan(450);
    expect(setup.options.resolveProvider).toHaveBeenCalledTimes(1);
    expect(setup.provider.verify).not.toHaveBeenCalled();
    expect(setup.store.getCandidate(setup.candidateId)?.state).toBe('candidate');
    expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
  });

  it.each(['fact', 'process'] as const)('validates managed %s from real intake without a second source manifest', async kind => {
    const setup = await fixture(kind, true);
    expect(setup.config.checkers[0]).not.toHaveProperty('evidence');
    expect(validationConfigurationSchema.safeParse(setup.config).success).toBe(true);
    expect(setup.store.getCandidate(setup.candidateId)?.state).toBe('candidate');
    expect(await validateConfiguredLearningCandidate(setup.input, setup.options)).toMatchObject({ status: 'validated', validatedVersion: 2 });
    const envelope = JSON.parse(setup.requests[0].target);
    expect(envelope.evidence.digest).toBe(setup.pack.digest);
    expect(envelope.evidence.sources.map((source: { id: string }) => source.id)).toEqual(['audit-1', 'session-1', 'session-2', 'session-3']);
    expect(envelope.evidence.sources.slice(1).map((source: { sourceDigest: string }) => source.sourceDigest))
      .toEqual([0, 2, 1].map(index => bytesDigest(readFileSync(setup.transcripts[index]))));
    expect(setup.store.getValidation(setup.candidateId)?.passed).toBe(true);
  });

  it('uses registered managed sources even when the checker configuration contains another source manifest', async () => {
    const setup = await fixture('fact', true);
    const alias = join(setup.root, 'alias.jsonl');
    writeFileSync(alias, readFileSync(setup.auditPath));
    setup.config.checkers[0].evidence = [{ digest: setup.pack.digest,
      sources: [{ id: 'audit-1', kind: 'audit', path: alias, allowedRoot: setup.root, runId: 'run-1' }] }];
    setup.persistConfig();
    expect((await validateConfiguredLearningCandidate(setup.input, setup.options)).status).toBe('validated');
    expect(JSON.parse(setup.requests[0].target).evidence.sources).toHaveLength(4);
  });

  it.each(['missing-root', 'no-independent-qa'] as const)('does not fall back to an explicit manifest for incomplete managed provenance: %s', async defect => {
    const setup = await fixture();
    const last = JSON.parse(readFileSync(setup.auditPath, 'utf8').trim());
    setup.store.commitScan({ scope, runId: 'run-1', analyzerVersion: setup.source.request.analyzerVersion, expectedCursor: null,
      cursor: { sequence: last.sequence, head: last.integrity.hash }, requests: [{ request: setup.source.request, evidence: setup.source.evidence }],
      ...(defect === 'missing-root' ? {} : { sourceRoot: dirname(setup.auditPath) }) }, [setup.pack]);
    expect(await validateConfiguredLearningCandidate(setup.input, setup.options)).toEqual(blocked('source_unavailable'));
    expect(setup.provider.verify).not.toHaveBeenCalled();
    expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
  });

  it('rereads managed transcript bytes after the final asynchronous doctor', async () => {
    const setup = await fixture('process', true);
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const diagnostics = vi.mocked(setup.provider.doctor!).getMockImplementation()!;
    vi.mocked(setup.provider.doctor!).mockImplementation(async operation => {
      if (vi.mocked(setup.provider.doctor!).mock.calls.length === 4) { started(); await barrier; }
      return diagnostics(operation);
    });
    const pending = validateConfiguredLearningCandidate(setup.input, setup.options);
    await entered;
    writeFileSync(setup.transcripts[0], 'changed after the final async reconciliation');
    release();
    expect(await pending).toEqual(blocked('source_unavailable'));
    expect(setup.provider.verify).toHaveBeenCalledTimes(1);
    expect(setup.store.getCandidate(setup.candidateId)?.state).toBe('candidate');
    expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
  });

  it.each(['missing-session', 'changed-session', 'session-symlink', 'missing-audit', 'changed-audit'] as const)(
    'blocks managed evidence with %s without requiring a per-candidate manifest', async change => {
      const setup = await fixture('fact', true);
      if (change === 'missing-session') rmSync(setup.transcripts[0]);
      if (change === 'changed-session') writeFileSync(setup.transcripts[0], 'changed');
      if (change === 'session-symlink') {
        const original = readFileSync(setup.transcripts[0]);
        rmSync(setup.transcripts[0]);
        const replacement = join(setup.root, 'replacement.jsonl');
        writeFileSync(replacement, original);
        symlinkSync(replacement, setup.transcripts[0]);
      }
      if (change === 'missing-audit') rmSync(setup.auditPath);
      if (change === 'changed-audit') writeFileSync(setup.auditPath, 'changed');
      expect((await validateConfiguredLearningCandidate(setup.input, setup.options)).status).toBe('blocked');
      expect(setup.provider.verify).not.toHaveBeenCalled();
      expect(setup.store.getCandidate(setup.candidateId)?.state).toBe('candidate');
      expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
    });

  it('refuses an imported request that borrows a managed run identity without registered request membership', async () => {
    const setup = await fixture('fact', true);
    const source = setup.store.submitRequest({ request: { ...setup.source.request, sourceId: 'unregistered-copy' }, evidence: setup.source.evidence }, setup.pack);
    const proposal = setup.store.getCandidate(setup.candidateId)!.proposal;
    const candidateId = setup.store.completeRequest(source.key, { version: 1, candidates: [proposal], warnings: [] }).candidateIds[0];
    expect((await validateConfiguredLearningCandidate({ ...setup.input, candidateId }, setup.options)).status).toBe('blocked');
    expect(setup.provider.verify).not.toHaveBeenCalled();
    expect(setup.store.getCandidate(candidateId)?.state).toBe('candidate');
    expect(setup.store.getValidation(candidateId)).toBeUndefined();
  });

  it('requires explicit source bindings for an unregistered import even when sourceRunId is present', async () => {
    const setup = await fixture();
    delete setup.config.checkers[0].evidence;
    setup.persistConfig();
    expect((await validateConfiguredLearningCandidate(setup.input, setup.options)).status).toBe('blocked');
    expect(setup.provider.verify).not.toHaveBeenCalled();
    expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
  });

  it.each(['fact', 'process'] as const)('validates %s against independent business oracle and real source, grant and target files', async kind => {
    const setup = await fixture(kind);
    expect(await validateConfiguredLearningCandidate(setup.input, setup.options)).toMatchObject({ status: 'validated', validatedVersion: 2 });
    expect(setup.store.getCandidate(setup.candidateId)?.state).toBe('validated');
    expect(setup.bindings).toHaveLength(2);
    expect(setup.bindings[0]).toMatchObject({ scope, checkerId: 'approval-policy', providerId: 'semantic-policy', version: '2026.11.1',
      snapshot: { path: setup.targetPath, content: readFileSync(setup.targetPath, 'utf8') } });
    expect(setup.requests[0]).not.toHaveProperty('command');
    const envelope = JSON.parse(setup.requests[0].target);
    const actualDigest = bytesDigest(readFileSync(setup.targetPath));
    expect(envelope.binding.target).toEqual({ scope, ref: 'wiki:approval', revision: `sha256:${actualDigest}`, snapshotDigest: actualDigest });
    const stored = setup.store.getValidation(setup.candidateId)!;
    const report = JSON.parse(Buffer.from(stored.results.map(part => part.slice('json-base64-v1:'.length)).join(''), 'base64').toString('utf8')).report;
    expect(report.binding).toEqual(envelope.binding);
    expect(report.assertions.every((assertion: { status: string }) => assertion.status === 'observed')).toBe(true);
  });

  it.each(['fact', 'process'] as const)('does not pass %s when the actual oracle disagrees with candidate expectations', async kind => {
    const setup = await fixture(kind);
    setup.oracle.approvalRequired = false;
    setup.oracle.approvedState = 'denied';
    setup.persistOracle();
    expect(await validateConfiguredLearningCandidate(setup.input, setup.options)).toEqual(blocked('assertion_failed'));
    expect(setup.store.getCandidate(setup.candidateId)?.state).toBe('candidate');
  });

  it('rejects publication with audit evidence for a different GitLab IPv4 host with the same redaction', async () => {
    const scope = 'gitlab:127.0.0.1:54231/acme/api';
    const setup = await fixture('fact', false, 'fixture-v1', scope, 'gitlab:127.0.0.2:54231/acme/api');
    expect(await validateConfiguredLearningCandidate(setup.input, setup.options)).toMatchObject({ status: 'validated', validatedVersion: 2 });
    await expect(prepareConfiguredKnowledge({ scope, file: setup.options.file, recoveryDirectory: join(setup.root, 'recovery'),
      validationConfigurationFile: setup.configurationFile, config: { wikiScript, grants: [setup.authorizationFile] },
      candidateId: setup.candidateId, expectedVersion: 2 })).rejects.toThrow('knowledge_publication_source_unavailable');
    expect(setup.store.listPublications()).toEqual([]);
  });

  it.each(['fact', 'process', 'lesson'] as const)('prepares a private GitLab IPv4 %s without persisting its host in evidence or preview', async kind => {
    const scope = 'gitlab:127.0.0.1:54231/acme/api';
    const setup = await fixture(kind, false, 'fixture-v1', scope);
    setup.grant.policy.targets[0].kinds.push('lesson');
    setup.persistGrant();
    setup.oracle.lesson.versions = ['fixture-v1'];
    setup.persistOracle();
    const vault = setup.grant.policy.vault;
    writeFileSync(join(vault, 'index.md'), page('Index', '[[backlinks]]'));
    writeFileSync(join(vault, 'backlinks.md'), page('Backlinks', '[[index]]'));
    writeFileSync(join(vault, 'template.md'), page('{{title}}', '{{knowledge}}'));
    const knowledge = { scope, file: setup.options.file, recoveryDirectory: join(setup.root, 'recovery'),
      validationConfigurationFile: setup.configurationFile, config: { wikiScript, grants: [setup.authorizationFile] } };
    expect(await validateConfiguredLearningCandidate(setup.input, setup.options)).toMatchObject({ status: 'validated', validatedVersion: 2 });
    const input = { ...knowledge, candidateId: setup.candidateId, expectedVersion: 2 };
    await expect(prepareConfiguredKnowledge({ ...input, scope: scope.replace('127.0.0.1', '127.0.0.2') })).rejects.toThrow();
    const publication = await prepareConfiguredKnowledge(input);
    expect(publication.phase).toBe('prepared');
    const saved = readFileSync(join(knowledge.recoveryDirectory, publication.key, 'plan.json'), 'utf8');
    expect(saved).not.toContain('127.0.0.1');
    expect(JSON.stringify(setup.pack)).not.toContain('127.0.0.1');
    expect(JSON.parse(saved).plan.changes[0].content).toContain(`## ${kind}`);
    expect(existsSync(join(vault, 'Approval.md'))).toBe(false);
  });

  it.each(['source invalidated', 'denied', 'authority drift', 'published authority drift'] as const)(
    'allows Wiki process publication only with independent, current approval: %s', async scenario => {
      const setup = await fixture('process', false, 'fixture-v1');
      const vault = setup.grant.policy.vault;
      const target = join(vault, 'Approval.md');
      const index = join(vault, 'index.md');
      const backlinks = join(vault, 'backlinks.md');
      const originalIndex = page('Index', '[[backlinks]]');
      const originalBacklinks = page('Backlinks', '[[index]]');
      writeFileSync(index, originalIndex);
      writeFileSync(backlinks, originalBacklinks);
      writeFileSync(join(vault, 'template.md'), page('{{title}}', '{{knowledge}}'));
      const knowledge = { scope, file: setup.options.file, recoveryDirectory: join(setup.root, 'recovery'),
        validationConfigurationFile: setup.configurationFile, config: { wikiScript, grants: [setup.authorizationFile] } };
      const prepare = (expectedVersion: number) => prepareConfiguredKnowledge({ ...knowledge, candidateId: setup.candidateId, expectedVersion });
      const expectUnwritten = () => {
        expect(existsSync(target)).toBe(false);
        expect(readFileSync(index, 'utf8')).toBe(originalIndex);
        expect(readFileSync(backlinks, 'utf8')).toBe(originalBacklinks);
      };
      expect(setup.store.getCandidate(setup.candidateId)).toMatchObject({ state: 'candidate', version: 1 });
      expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
      if (scenario === 'denied') {
        setup.oracle.approvedState = 'denied';
        setup.persistOracle();
      }
      const validation = await validateConfiguredLearningCandidate(setup.input, setup.options);
      expect(setup.provider.verify).toHaveBeenCalledTimes(1);
      if (scenario === 'denied') {
        expect(validation).toEqual(blocked('assertion_failed'));
        await expect(prepare(1)).rejects.toThrow('Knowledge publication requires current version and validation receipt');
        expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
        expect(setup.store.listPublications()).toEqual([]);
        expectUnwritten();
        return;
      }
      expect(validation).toMatchObject({ status: 'validated', candidateId: setup.candidateId, validatedVersion: 2 });
      const receipt = setup.store.getValidation(setup.candidateId);
      expect(receipt).toMatchObject({ passed: true, candidateVersion: 1, validatedVersion: 2 });
      const prepared = await prepare(2);
      expect(prepared).toMatchObject({ phase: 'prepared', candidateId: setup.candidateId, candidateVersion: 2,
        validatorVersion: receipt!.validatorVersion });
      expectUnwritten();
      if (scenario === 'authority drift') {
        setup.oracle.approvedState = 'denied';
        setup.persistOracle();
      }
      const result = await publishConfiguredKnowledge({ ...knowledge, key: prepared.key });
      if (scenario === 'authority drift') {
        expect(result.publication.phase).toBe('conflict');
        expect(setup.store.getCandidate(setup.candidateId)?.state).not.toBe('published');
        expectUnwritten();
        return;
      }
      expect(result.publication).toMatchObject({ key: prepared.key, phase: 'committed' });
      expect(setup.store.getCandidate(setup.candidateId)).toMatchObject({ state: 'published', version: 3 });
      const content = readFileSync(target, 'utf8');
      expect(content).toContain('draft -> approved');
      expect(content).toContain('approved -> published');
      expect(content).toContain('denied -> draft');
      expect(readFileSync(index, 'utf8')).toContain('[[Approval');
      expect(readFileSync(backlinks, 'utf8')).toContain('[[Approval');

      const context = new KnowledgeContextProvider(knowledge);
      const query = { scope, prompt: 'Approval', applicability: { version: 'fixture-v1' } };
      expect(await context.gather({ scope, prompt: query.prompt })).toEqual([]);
      expect(await context.gather({ ...query, applicability: { version: 'fixture-v2' } })).toEqual([]);
      expect(await context.gather(query)).toEqual([{ origin: `knowledge:${prepared.key}; target:wiki:approval`, content }]);
      if (scenario === 'source invalidated') setup.store.invalidateRequestSource(setup.source.key);
      else {
        setup.oracle.approvedState = 'denied';
        setup.persistOracle();
      }
      expect(await context.gather(query)).toEqual([]);
      expect(readFileSync(target, 'utf8')).toBe(content);
      expect(await reconcileConfiguredKnowledge(knowledge)).toMatchObject({ blocked: [], results: [
        { publication: { key: prepared.key }, withdrawal: { key: prepared.key, status: 'withdrawn' } },
      ] });
      const withdrawn = readFileSync(target, 'utf8');
      expect(withdrawn).toContain('knowledge_status: revoked');
      expect(withdrawn).not.toContain('approved -> published');
      if (scenario === 'published authority drift') {
        setup.oracle.approvedState = 'approved';
        setup.persistOracle();
      }
      expect(await context.gather(query)).toEqual([]);
      expect(await reconcileConfiguredKnowledge(knowledge)).toMatchObject({ blocked: [], results: [
        { publication: { key: prepared.key }, withdrawal: { key: prepared.key, status: 'withdrawn' } },
      ] });
      expect(readFileSync(target, 'utf8')).toBe(withdrawn);
    });

  it.each(['passed', 'command', 'target', 'providerId', 'version', 'report'])('rejects client %s before reading private configuration', async field => {
    const setup = await fixture();
    expect(await validateConfiguredLearningCandidate({ ...setup.input, [field]: 'forged' }, setup.options)).toEqual(blocked('invalid_input'));
    expect(setup.options.resolveProvider).not.toHaveBeenCalled();
    expect(setup.provider.verify).not.toHaveBeenCalled();
  });

  it('exports a strict persisted configuration schema with unambiguous scoped checker identities', async () => {
    const setup = await fixture();
    expect(validationConfigurationSchema.parse(setup.config)).toEqual(setup.config);
    const entry = setup.config.checkers[0];
    for (const changes of [{ scope: 'acme/api' }, { passed: true }, { command: ['sh'] }, { version: '' },
      { authorizationFile: 'relative.json' }, { target: { ...entry.target, path: '../secret' } },
      { target: { ...entry.target, path: '/secret' } }, { target: { ...entry.target, root: 'relative' } },
      { evidence: [{ ...entry.evidence![0], sources: [{ ...entry.evidence![0].sources[0], command: ['sh'] }] }] }]) {
      expect(validationConfigurationSchema.safeParse({ ...setup.config, checkers: [{ ...entry, ...changes }] }).success).toBe(false);
    }
    expect(validationConfigurationSchema.safeParse({ ...setup.config, checkers: [entry, { ...entry, providerId: 'other' }] }).success).toBe(false);
    expect(validationConfigurationSchema.safeParse({ ...setup.config, checkers: [{ ...entry, evidence: [entry.evidence![0], entry.evidence![0]] }] }).success).toBe(false);
  });

  it.each(['scope', 'checkerId', 'providerId', 'version'])('requires exact persisted and provider doctor %s binding', async field => {
    const setup = await fixture();
    setup.doctorIdentity({ [field]: 'different' });
    expect((await validateConfiguredLearningCandidate(setup.input, setup.options)).status).toBe('blocked');
    expect(setup.provider.verify).not.toHaveBeenCalled();
  });

  it('refuses the ordinary command test-runner without invoking host execution', async () => {
    const setup = await fixture();
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: 'passed', stderr: '' }));
    const ordinary = new TestRunnerVerificationProvider({ runner });
    setup.config.checkers[0].providerId = ordinary.id;
    setup.persistConfig();
    vi.mocked(setup.options.resolveProvider).mockResolvedValue(ordinary);
    expect((await validateConfiguredLearningCandidate(setup.input, setup.options)).status).toBe('blocked');
    expect(runner).not.toHaveBeenCalled();
  });

  it.each(['missing', 'generic-doctor', 'wrong-id'])('blocks an unavailable or incompatible provider: %s', async defect => {
    const setup = await fixture();
    if (defect === 'missing') vi.mocked(setup.options.resolveProvider).mockResolvedValue(undefined);
    if (defect === 'generic-doctor') vi.mocked(setup.provider.doctor!).mockResolvedValue([{ check: 'learning-validation-v1', ok: true }]);
    if (defect === 'wrong-id') Object.assign(setup.provider, { id: 'different' });
    expect((await validateConfiguredLearningCandidate(setup.input, setup.options)).status).toBe('blocked');
    expect(setup.provider.verify).not.toHaveBeenCalled();
  });

  it.each(['source-change', 'source-missing', 'target-change', 'grant-revoked', 'grant-policy', 'grant-replaced', 'config-change', 'config-replaced', 'rules-change'])(
    'refuses promotion when %s occurs during checker execution', async change => {
      const setup = await fixture();
      setup.during(() => {
        if (change === 'source-change') writeFileSync(setup.auditPath, 'tampered');
        if (change === 'source-missing') rmSync(setup.auditPath);
        if (change === 'target-change') { setup.oracle.approvalRequired = false; setup.persistOracle(); }
        if (change === 'grant-revoked') { setup.grant.revoked = true; setup.persistGrant(); }
        if (change === 'grant-policy') { setup.grant.policy.targets[0].kinds = ['fact']; setup.persistGrant(); }
        if (change === 'grant-replaced') { rmSync(setup.authorizationFile); setup.persistGrant(); }
        if (change === 'config-change') { setup.config.checkers[0].version = '2026.11.2'; setup.persistConfig(); }
        if (change === 'config-replaced') { rmSync(setup.configurationFile); setup.persistConfig(); }
        if (change === 'rules-change') writeFileSync(join(setup.grant.policy.vault, 'AGENTS.md'), '# Changed\n');
      });
      const result = await validateConfiguredLearningCandidate(setup.input, setup.options);
      expect(result.status).toBe('blocked');
      expect(setup.store.getCandidate(setup.candidateId)?.state).toBe('candidate');
      expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(setup.root);
    });

  it.each(['public-config', 'public-grant', 'config-symlink', 'grant-symlink', 'config-hardlink', 'parent-public', 'oversized-config'])(
    'requires owned private persistent configuration and authorization: %s', async defect => {
      const setup = await fixture();
      if (defect === 'public-config') chmodSync(setup.configurationFile, 0o644);
      if (defect === 'public-grant') chmodSync(setup.authorizationFile, 0o644);
      if (defect === 'config-symlink') { const alternate = join(setup.root, 'link.json'); symlinkSync(setup.configurationFile, alternate); setup.options.configurationFile = alternate; }
      if (defect === 'grant-symlink') { const alternate = join(setup.root, 'link.json'); symlinkSync(setup.authorizationFile, alternate); setup.config.checkers[0].authorizationFile = alternate; setup.persistConfig(); }
      if (defect === 'config-hardlink') linkSync(setup.configurationFile, join(setup.root, 'hardlink.json'));
      if (defect === 'parent-public') chmodSync(setup.root, 0o755);
      if (defect === 'oversized-config') writeFileSync(setup.configurationFile, ' '.repeat(1024 * 1024 + 1));
      expect((await validateConfiguredLearningCandidate(setup.input, setup.options)).status).toBe('blocked');
      expect(setup.provider.verify).not.toHaveBeenCalled();
    });

  it.each(['wrong-scope', 'wrong-target', 'revoked', 'unsupported-kind'])('checks the existing persisted knowledge grant before execution: %s', async defect => {
    const setup = await fixture('process');
    if (defect === 'wrong-scope') setup.grant.policy.scope = 'github:other/api';
    if (defect === 'wrong-target') setup.grant.policy.targets[0].ref = 'wiki:other';
    if (defect === 'revoked') setup.grant.revoked = true;
    if (defect === 'unsupported-kind') setup.grant.policy.targets[0].kinds = ['fact'];
    setup.persistGrant();
    expect(await validateConfiguredLearningCandidate(setup.input, setup.options)).toEqual(blocked('unauthorized'));
    expect(setup.provider.verify).not.toHaveBeenCalled();
  });

  it.each(['unbound-digest', 'wrong-source', 'missing-source', 'missing-target', 'target-symlink', 'target-too-large'])('blocks a missing or unsafe snapshot binding: %s', async defect => {
    const setup = await fixture();
    if (defect === 'unbound-digest') setup.config.checkers[0].evidence![0].digest = '0'.repeat(64);
    if (defect === 'wrong-source') setup.config.checkers[0].evidence![0].sources[0].id = 'other-audit';
    if (defect === 'missing-source') rmSync(setup.auditPath);
    if (defect === 'missing-target') rmSync(setup.targetPath);
    if (defect === 'target-symlink') { const original = readFileSync(setup.targetPath); rmSync(setup.targetPath); writeFileSync(join(setup.root, 'other.json'), original); symlinkSync(join(setup.root, 'other.json'), setup.targetPath); }
    if (defect === 'target-too-large') writeFileSync(setup.targetPath, 'a'.repeat(128 * 1024 + 1));
    setup.persistConfig();
    expect((await validateConfiguredLearningCandidate(setup.input, setup.options)).status).toBe('blocked');
    expect(setup.provider.verify).not.toHaveBeenCalled();
  });

  it('detects revocation while provider resolution is waiting, before verify can start', async () => {
    const setup = await fixture();
    vi.mocked(setup.options.resolveProvider).mockImplementation(async () => {
      setup.grant.revoked = true;
      setup.persistGrant();
      return setup.provider;
    });
    expect((await validateConfiguredLearningCandidate(setup.input, setup.options)).status).toBe('blocked');
    expect(setup.provider.verify).not.toHaveBeenCalled();
  });

  it('honors cancellation and sanitizes resolver exceptions without leaking private paths', async () => {
    const setup = await fixture();
    const signal = new AbortController();
    signal.abort();
    expect(await validateConfiguredLearningCandidate(setup.input, { ...setup.options, signal: signal.signal })).toEqual(blocked('cancelled'));
    expect(setup.options.resolveProvider).not.toHaveBeenCalled();
    vi.mocked(setup.options.resolveProvider).mockRejectedValue(new Error(`secret-token ${setup.root}`));
    expect(await validateConfiguredLearningCandidate(setup.input, setup.options)).toEqual(blocked('checker_unavailable'));
  });

  it.each(['scope', 'checkerId'] as const)('does not fall back to a persisted checker with a different %s', async field => {
    const setup = await fixture();
    setup.config.checkers[0][field] = field === 'scope' ? 'github:other/api' : 'different';
    setup.persistConfig();
    expect((await validateConfiguredLearningCandidate(setup.input, setup.options)).status).toBe('blocked');
    expect(setup.options.resolveProvider).not.toHaveBeenCalled();
  });

  it.each(['source', 'target', 'config', 'grant'])('rechecks %s after the asynchronous provider resolver, before execution', async changed => {
    const setup = await fixture();
    vi.mocked(setup.options.resolveProvider).mockImplementation(async () => {
      if (changed === 'source') writeFileSync(setup.auditPath, 'changed source');
      if (changed === 'target') { setup.oracle.approvedState = 'denied'; setup.persistOracle(); }
      if (changed === 'config') { setup.config.checkers[0].version = '2'; setup.persistConfig(); }
      if (changed === 'grant') { setup.grant.revoked = true; setup.persistGrant(); }
      return setup.provider;
    });
    expect((await validateConfiguredLearningCandidate(setup.input, setup.options)).status).toBe('blocked');
    expect(setup.provider.verify).not.toHaveBeenCalled();
    expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
  });

  it.each(['scope', 'checkerId', 'providerId', 'version'])('rechecks provider doctor %s identity after execution', async field => {
    const setup = await fixture();
    setup.during(() => { setup.doctorIdentity({ [field]: 'changed' }); });
    expect((await validateConfiguredLearningCandidate(setup.input, setup.options)).status).toBe('blocked');
    expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
  });

  it.each(['missing', 'negative', 'duplicate', 'malformed', 'unknown-field', 'large'])('requires a bounded unambiguous doctor binding: %s', async defect => {
    const setup = await fixture();
    if (defect === 'missing') setup.provider.doctor = undefined;
    else {
      const binding = { scope, checkerId: 'approval-policy', providerId: 'semantic-policy', version: '2026.11.1' };
      const declared = { check: 'learning-validation-v1', ok: true, detail: JSON.stringify(binding) };
      if (defect === 'negative') declared.ok = false;
      if (defect === 'malformed') declared.detail = 'not JSON';
      if (defect === 'unknown-field') declared.detail = JSON.stringify({ ...binding, command: ['sh'] });
      if (defect === 'large') declared.detail = 'a'.repeat(2049);
      vi.mocked(setup.provider.doctor!).mockResolvedValue(defect === 'duplicate' ? [declared, declared] : [declared]);
    }
    expect(await validateConfiguredLearningCandidate(setup.input, setup.options)).toEqual(blocked('checker_unavailable'));
    expect(setup.provider.verify).not.toHaveBeenCalled();
  });

  it('uses the actual scope, candidate version and state before accessing trusted configuration', async () => {
    const setup = await fixture();
    expect(await validateConfiguredLearningCandidate({ ...setup.input, scope: 'github:other/api' }, setup.options)).toEqual(blocked('scope_mismatch'));
    expect(await validateConfiguredLearningCandidate({ ...setup.input, expectedVersion: 2 }, setup.options)).toEqual(blocked('stale_candidate'));
    setup.store.transitionCandidate(setup.candidateId, 1, 'conflict');
    expect(await validateConfiguredLearningCandidate(setup.input, setup.options)).toEqual(blocked('stale_candidate'));
    expect(setup.options.resolveProvider).not.toHaveBeenCalled();
  });

  it('lets only one concurrent validation promote the candidate', async () => {
    const setup = await fixture();
    let release!: () => void;
    let started = 0;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    setup.during(async () => { started += 1; if (started === 2) release(); await barrier; });
    const results = await Promise.all([validateConfiguredLearningCandidate(setup.input, setup.options), validateConfiguredLearningCandidate(setup.input, setup.options)]);
    expect(results.filter(result => result.status === 'validated')).toHaveLength(1);
    expect(results.filter(result => result.status === 'blocked')).toEqual([blocked('stale_candidate')]);
    expect(setup.store.getCandidate(setup.candidateId)?.version).toBe(2);
  });

  it('does not create missing ledgers or persist client reports', async () => {
    const setup = await fixture();
    expect(await validateConfiguredLearningCandidate(setup.input, { ...setup.options, file: join(setup.root, 'missing.sqlite') })).toEqual(blocked('candidate_unavailable'));
    expect(setup.store.getCandidate(setup.candidateId)?.state).toBe('candidate');
    expect(setup.options.resolveProvider).not.toHaveBeenCalled();
  });

  it('does not promote late provider success after cancellation closes its ledger handle', async () => {
    const setup = await fixture();
    const controller = new AbortController();
    let release!: () => void;
    setup.during(() => new Promise<void>(resolve => { release = resolve; }));
    const pending = validateConfiguredLearningCandidate(setup.input, { ...setup.options, signal: controller.signal });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    controller.abort();
    expect(await pending).toEqual(blocked('cancelled'));
    release();
    await new Promise(resolve => setImmediate(resolve));
    expect(setup.store.getCandidate(setup.candidateId)?.state).toBe('candidate');
    expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
  });

  it('bounds provider output and returns finite errors without leaking report secrets', async () => {
    const setup = await fixture();
    vi.mocked(setup.provider.verify).mockResolvedValue({ passed: true, durationMs: 0, output: `secret=${'a'.repeat(32768)}` });
    expect(await validateConfiguredLearningCandidate(setup.input, setup.options)).toEqual(blocked('output_limit'));
    expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
  });

  it.each(['source', 'grant', 'target', 'config', 'rules', 'source-symlink', 'target-symlink', 'grant-permissions', 'grant-replaced', 'config-replaced', 'provider'] as const)(
    'reads actual %s synchronously after the final doctor await before committing', async changed => {
      const setup = await fixture();
      let release!: () => void;
      let started!: () => void;
      const entered = new Promise<void>(resolve => { started = resolve; });
      const barrier = new Promise<void>(resolve => { release = resolve; });
      const diagnostics = vi.mocked(setup.provider.doctor!).getMockImplementation()!;
      vi.mocked(setup.provider.doctor!).mockImplementation(async operation => {
        if (vi.mocked(setup.provider.doctor!).mock.calls.length === 4) { started(); await barrier; }
        return diagnostics(operation);
      });
      const pending = validateConfiguredLearningCandidate(setup.input, setup.options);
      await entered;
      if (changed === 'source') writeFileSync(setup.auditPath, 'externally changed');
      if (changed === 'grant') { setup.grant.revoked = true; setup.persistGrant(); }
      if (changed === 'target') { setup.oracle.approvalRequired = false; setup.persistOracle(); }
      if (changed === 'config') { setup.config.checkers[0].version = 'changed'; setup.persistConfig(); }
      if (changed === 'rules') writeFileSync(join(setup.grant.policy.vault, 'AGENTS.md'), 'changed rules');
      if (changed === 'grant-permissions') chmodSync(setup.authorizationFile, 0o644);
      if (changed === 'grant-replaced' || changed === 'config-replaced') {
        const path = changed === 'grant-replaced' ? setup.authorizationFile : setup.configurationFile;
        const original = readFileSync(path);
        rmSync(path);
        writeFileSync(path, original, { mode: 0o600 });
      }
      if (changed === 'provider') setup.provider.verify = vi.fn(async () => ({ passed: true, output: '', durationMs: 0 }));
      if (changed === 'source-symlink' || changed === 'target-symlink') {
        const path = changed === 'source-symlink' ? setup.auditPath : setup.targetPath;
        const replacement = join(setup.root, 'replacement');
        writeFileSync(replacement, readFileSync(path));
        rmSync(path);
        symlinkSync(replacement, path);
      }
      release();
      const result = await pending;
      expect(result.status).toBe('blocked');
      expect(JSON.stringify(result)).not.toContain(setup.root);
      expect(setup.store.getCandidate(setup.candidateId)?.state).toBe('candidate');
      expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
      expect(setup.provider.doctor).toHaveBeenCalledTimes(4);
    });

  it.each(['scope', 'checkerId', 'providerId', 'version'] as const)('validates final doctor %s identity rather than trusting the earlier declaration', async field => {
    const setup = await fixture();
    const diagnostics = vi.mocked(setup.provider.doctor!).getMockImplementation()!;
    vi.mocked(setup.provider.doctor!).mockImplementation(async operation => {
      if (vi.mocked(setup.provider.doctor!).mock.calls.length === 4) setup.doctorIdentity({ [field]: 'changed' });
      return diagnostics(operation);
    });
    expect((await validateConfiguredLearningCandidate(setup.input, setup.options)).status).toBe('blocked');
    expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
  });

  it('rejects a deadline crossed during the final doctor before the timeout callback runs', async () => {
    const setup = await fixture();
    const timeoutMs = 30_000;
    const startedAt = 1_000;
    const clock = vi.spyOn(performance, 'now').mockReturnValue(startedAt);
    const diagnostics = vi.mocked(setup.provider.doctor!).getMockImplementation()!;
    vi.mocked(setup.provider.doctor!).mockImplementation(async operation => {
      if (vi.mocked(setup.provider.doctor!).mock.calls.length === 4) clock.mockReturnValue(startedAt + timeoutMs + 1);
      return diagnostics(operation);
    });
    expect(await validateConfiguredLearningCandidate(setup.input, { ...setup.options, timeoutMs })).toEqual(blocked('timed_out'));
    expect(setup.provider.doctor).toHaveBeenCalledTimes(4);
    expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
  });

  it.each([
    ...(['unchanged', 'source', 'grant', 'target', 'config'] as const).map(changed => ({ changed, managed: false })),
    ...(['unchanged', 'source', 'grant', 'target', 'config', 'session'] as const).map(changed => ({ changed, managed: true })),
  ])('uses actual post-lock $changed state after a real SQLite writer wait (managed=$managed)', async ({ changed, managed }) => {
      const setup = await fixture('fact', managed);
      const configuration = structuredClone(setup.config);
      configuration.checkers[0].version = 'changed';
      const mutations = {
        source: { path: setup.auditPath, content: 'changed while waiting for SQLite writer' },
        grant: { path: setup.authorizationFile, content: JSON.stringify({ ...setup.grant, revoked: true }) },
        target: { path: setup.targetPath, content: JSON.stringify({ ...setup.oracle, approvalRequired: false }) },
        config: { path: setup.configurationFile, content: JSON.stringify(configuration) },
        session: { path: setup.transcripts[0], content: 'session changed during SQLite writer wait' },
      };
      const coordination = new SharedArrayBuffer(12);
      const state = new Int32Array(coordination);
      const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        const { DatabaseSync } = require('node:sqlite');
        const { writeFileSync } = require('node:fs');
        const database = new DatabaseSync(workerData.file);
        const state = new Int32Array(workerData.coordination);
        parentPort.postMessage('ready');
        Atomics.wait(state, 0, 0);
        database.exec('BEGIN IMMEDIATE');
        Atomics.store(state, 1, 1);
        Atomics.notify(state, 1);
        Atomics.wait(state, 0, 1, 120);
        if (workerData.mutation) writeFileSync(workerData.mutation.path, workerData.mutation.content);
        Atomics.store(state, 2, 1);
        Atomics.wait(state, 0, 1, 130);
        database.exec('COMMIT');
        database.close();
      `, { eval: true, workerData: { file: setup.options.file, coordination,
        mutation: changed === 'unchanged' ? undefined : mutations[changed] } });
      cleanups.push(() => { void worker.terminate(); });
      await new Promise<void>((resolve, reject) => { worker.once('message', () => resolve()); worker.once('error', reject); });
      const diagnostics = vi.mocked(setup.provider.doctor!).getMockImplementation()!;
      vi.mocked(setup.provider.doctor!).mockImplementation(async operation => {
        if (vi.mocked(setup.provider.doctor!).mock.calls.length === 4) {
          Atomics.store(state, 0, 1);
          Atomics.notify(state, 0);
          if (Atomics.wait(state, 1, 0, 1000) === 'timed-out') throw new Error('writer lock not acquired');
        }
        return diagnostics(operation);
      });
      const record = vi.spyOn(CandidateStore.prototype, 'recordValidation');
      try {
        const started = performance.now();
        const result = await validateConfiguredLearningCandidate(setup.input, { ...setup.options, timeoutMs: 1500 });
        expect(record).toHaveBeenCalledTimes(1);
        expect(performance.now() - started).toBeGreaterThan(200);
        expect(Atomics.load(state, 2)).toBe(1);
        if (changed === 'unchanged') {
          expect(result.status).toBe('validated');
          expect(setup.store.getValidation(setup.candidateId)?.validatedVersion).toBe(2);
        } else {
          expect(result.status).toBe('blocked');
          expect(result).not.toEqual(blocked('timed_out'));
          expect(setup.store.getCandidate(setup.candidateId)?.state).toBe('candidate');
          expect(setup.store.getCandidateVersions(setup.candidateId)).toHaveLength(1);
          expect(setup.store.getValidation(setup.candidateId)).toBeUndefined();
        }
      } finally { record.mockRestore(); }
    });
});
