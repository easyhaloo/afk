import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockerContainerProvider } from '../../infrastructure/sandbox/container/docker.js';
import { executeFrozenContainer, verifyFrozenScratchRecoveryEvidence, type FrozenExecutionOptions,
  type FrozenExecutionResult } from '../../infrastructure/sandbox/container/frozen-execution.js';
import { assertFrozenScratchHelper, captureFrozenScratchHelper } from '../../infrastructure/sandbox/container/frozen-input.js';
import type { FrozenContainerInspection, FrozenContainerOperations } from '../../infrastructure/sandbox/container/types.js';
import type { RepositoryProvider, RepositoryWorkspace } from '../../plugin-sdk/capabilities.js';
import { output } from './ledger-data.fixture.spec.js';
import { verifyRepositoryAssetProposal, type ProposalRuntimeCase, type ProposalRuntimeObservation,
  type ProposalRuntimeOptions } from './proposal-runtime.js';
import { observeProposalExperiment, prepareProposalExperiment, type ProposalSemanticConfiguration,
  type ProposalSemanticExecutionContext } from './proposal-semantics.js';
import { prepareAssetProposal, type ProposalInventory } from './proposals.js';
import { canonicalLearningJson } from './requests.js';

const roots: string[] = [];
const baseImageId = `sha256:${'a'.repeat(64)}`;
const imageId = `sha256:${'b'.repeat(64)}`;
const faultInput = '{"phase":"fault","key":"saved"}';
const recoveryInput = '{"phase":"recover","key":"saved"}';
const names = ['fault', 'recovery', 'replay'] as const;
type RecoveryConfiguration = NonNullable<ProposalSemanticConfiguration['recovery']>;
type ContainerRegistration = NonNullable<FrozenExecutionOptions['onContainer']>;
type RegistrationMode = 'valid' | 'missing' | 'operation' | 'container' | 'duplicate';
const returns: RecoveryConfiguration['returnAssertions'] = {
  fault: { exitCode: 23, signal: null, stdoutHex: Buffer.from('partial\n').toString('hex'), stderrHex: Buffer.from('fault\n').toString('hex') },
  recovery: { exitCode: 0, signal: null, stdoutHex: Buffer.from('recovered\n').toString('hex'), stderrHex: '' },
  replay: { exitCode: 0, signal: null, stdoutHex: Buffer.from('already-ready\n').toString('hex'), stderrHex: '' },
};
const bytesDigest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => bytesDigest(canonicalLearningJson(value));
const state = (value: string | null) => [{ id: 'state', path: 'state.json', bytes: value === null ? null : Buffer.from(value).toString('base64') }];
const wireState = (value: string | null) => [{ id: 'state', path: 'state.json', present: value !== null,
  hex: value === null ? null : Buffer.from(value).toString('hex') }];

function directory(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'afk-proposal-recovery-runtime-')));
  roots.push(root);
  return root;
}

function git(root: string, ...argumentsValue: string[]): string {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) if (name.startsWith('GIT_')) delete environment[name];
  Object.assign(environment, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
  return execFileSync('git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'core.fsmonitor=false', '-C', root, ...argumentsValue], { encoding: 'utf8', stdio: 'pipe', env: environment }).trim();
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type BaselineCase = 'fault-exit' | 'recovery-exit' | 'replay-exit' | 'phase-output' | 'checkpoint' | 'observer-stderr' | 'foreign-frame';
function fixture(returnAssertions: RecoveryConfiguration['returnAssertions'] = returns, baselineCase?: BaselineCase) {
  const root = directory();
  const original = 'console.log(JSON.stringify({value:"old"}));\n';
  writeFileSync(join(root, 'asset.js'), original);
  writeFileSync(join(root, 'untouched.txt'), 'baseline');
  git(root, 'init', '-b', 'main');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  const commit = git(root, 'rev-parse', 'HEAD');
  const inventory: ProposalInventory = { skills: [], toolSearches: ['cli', 'script', 'plugin'], tools: [{ kind: 'script', ref: 'script:fixture',
    name: 'fixture', description: 'Existing fixture', provenance: 'configured-repository', source: { root, file: join(root, 'asset.js') } }] };
  const prepared = prepareAssetProposal({ ...output.candidates[0], kind: 'tool', targetRef: 'script:fixture', title: 'Fixture tool', payload: {
    existingTools: ['script:fixture'], inputSchema: { type: 'object', properties: {
      phase: { type: 'string', enum: ['fault', 'recover'] }, key: { type: 'string', pattern: '^[a-z]+$' },
    }, required: ['key'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
    source: 'console.log(JSON.stringify({value:"new"}));', dependencies: [], permissions: [], timeoutMs: 500,
    sideEffects: 'none', idempotency: 'Same final bytes after replay', recovery: 'Retry after a partial write', tests: [
      { kind: 'recovery', input: 'Retry after a partial write', expected: 'Bounded fault, recovery and replay returns and state' },
      { kind: 'normal', input: '{"key":"alpha"}', expected: '{"value":"new"}' },
      { kind: 'normal', input: '{"key":"beta"}', expected: '{"value":"new"}' },
      { kind: 'refusal', input: '{"key":"../unsafe"}', expected: 'Refuse unsafe input' },
    ],
  } }, inventory);
  const recoveryCheck = prepared.checks.find(check => check.kind === 'recovery')!;
  const configured: ProposalSemanticConfiguration = { protocol: 'proposal-semantic-v1', adapter: 'node-json-argv-v1', kind: 'recovery',
    input: recoveryCheck.input, callInput: faultInput,
    assertions: [{ id: 'outer-exit', source: 'exit-code', expected: 0 },
      { id: 'business-stdout', source: 'stdout', expected: names.map(phase => Buffer.from(returnAssertions[phase].stdoutHex, 'hex').toString('utf8')).join('') },
      { id: 'business-stderr', source: 'stderr', expected: names.map(phase => Buffer.from(returnAssertions[phase].stderrHex, 'hex').toString('utf8')).join('') }],
    recovery: { contractRevision: 'bounded-recovery-return-state-v1', resources: [{ id: 'state', path: 'state.json' }],
      callInput: recoveryInput, requireEffectHistory: false,
      assertions: { fault: state('partial:saved'), recovered: state('ready:saved'), replayed: state('ready:saved') }, returnAssertions },
  };
  if (prepared.proposal.kind !== 'tool') throw new Error('Expected a tool fixture');
  const preparation = prepareProposalExperiment('tool', 'asset.js', recoveryCheck, configured, prepared.proposal.payload.inputSchema);
  if (preparation.status !== 'prepared') throw new Error('Expected a prepared recovery fixture');
  const experiment = preparation.experiment;
  const helperBytes = Buffer.alloc(120);
  Buffer.from([127, 69, 76, 70, 2, 1, 1]).copy(helperBytes);
  helperBytes.writeUInt16LE(2, 16);
  helperBytes.writeUInt16LE(62, 18);
  helperBytes.writeBigUInt64LE(64n, 32);
  helperBytes.writeUInt16LE(56, 54);
  helperBytes.writeUInt16LE(1, 56);
  helperBytes.writeUInt32LE(1, 64);
  const helperPath = join(directory(), 'synthetic-helper.elf');
  writeFileSync(helperPath, helperBytes);
  const helper = captureFrozenScratchHelper(helperPath, bytesDigest(helperBytes));
  const workspace: RepositoryWorkspace = { id: randomUUID(), runId: 'run-recovery-fixture', repository: { url: 'fixture', ref: 'main' },
    snapshot: { commit, branch: 'main', dirty: false }, path: root };
  const repository: RepositoryProvider = { id: 'configured-fixture', capabilities: { read: true, clone: true, push: false, prepare: true, checkout: true, cleanup: true },
    snapshot: vi.fn(async () => workspace.snapshot), withLifecycleLease: async (_request, operation) => operation(),
    prepare: vi.fn(async () => workspace), checkout: vi.fn(async () => workspace), cleanup: vi.fn(async () => ({ removed: true })), publish: vi.fn() };
  const requests: FrozenExecutionOptions[] = [];
  const registrations: Parameters<ContainerRegistration>[0][] = [];
  let registrationMode: RegistrationMode = 'valid';
  let active: FrozenExecutionOptions | undefined;
  let operationId = '';
  let containerId = '';
  let argv: readonly string[] = [];
  let completed = false;
  const inspection = (): FrozenContainerInspection => ({ id: containerId, imageId, operationId, name: `afk-frozen-${operationId}`,
    status: completed ? 'exited' : 'created', exitCode: 0, user: '1000:1000', readOnlyRoot: true, network: 'none', capDrop: ['ALL'],
    securityOptions: ['no-new-privileges'], privileged: false, pidMode: '', ipcMode: 'private', binds: [], mounts: [],
    tmpfs: { '/scratch': 'rw,noexec,nosuid,nodev,size=16777216,mode=700,uid=1000,gid=1000' }, memory: 268435456,
    memorySwap: 268435456, nanoCpus: 1_000_000_000, pidsLimit: 64, entrypoint: ['/usr/bin/env'],
    command: ['-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/scratch', 'TMPDIR=/scratch', ...argv], workdir: '/workspace' });
  const engine: FrozenContainerOperations = {
    buildFrozenImage: vi.fn(async identifier => { operationId = identifier; completed = false; return imageId; }),
    createFrozenContainer: vi.fn(async (identifier, _image, command) => {
      containerId = bytesDigest(`container:${identifier}`);
      argv = command;
      return containerId;
    }),
    inspectFrozenContainer: vi.fn(async () => inspection()),
    startFrozenContainer: vi.fn(async () => {
      completed = true;
      const scratch = active?.scratch;
      if (!scratch) return { code: 0, stdout: '{"value":"new"}', stderr: '' };
      const frame = { revision: 'linux-native-scratch-recovery-v1', operationId, inputDigest: active!.input.digest,
        helperDigest: helper.digest, artifactDigest: active!.input.manifest.find(entry => entry.path === 'asset.js')!.digest,
        candidateVersion: scratch.candidateVersion, initialSampledMs: 1, initial: wireState(null), phases: names.map((phase, index) => ({
          phase, ordinal: index + 1, invocationId: `${operationId}:${index + 1}`, callInputDigest: bytesDigest(index === 0 ? faultInput : recoveryInput),
          invocation: { pid: index + 7, startedIdentity: String(123 + index), execConfirmed: true, startedMs: index * 3 + 2,
            finishedMs: index * 3 + 3, exitCode: index === 0 ? 23 : 0, signal: null },
          sampledMs: index * 3 + 4, final: wireState(index === 0 ? 'partial:saved' : 'ready:saved'),
          stdoutHex: returnAssertions[phase].stdoutHex, stderrHex: returnAssertions[phase].stderrHex,
        })) };
      if (scratch.candidateVersion === 'original' && baselineCase) {
        if (baselineCase === 'observer-stderr') return { code: 0, stdout: '', stderr: 'observer failure' };
        if (baselineCase === 'foreign-frame') frame.operationId = 'unrelated-operation';
        if (baselineCase === 'checkpoint') frame.phases[1]!.final = wireState('partial:saved');
        if (baselineCase === 'phase-output') frame.phases[1]!.stdoutHex = '';
        const stop = ['fault-exit', 'recovery-exit', 'replay-exit'].indexOf(baselineCase);
        if (stop >= 0) {
          frame.revision = 'linux-native-original-exit-v1';
          frame.phases.length = stop + 1;
          frame.phases[stop]!.invocation.exitCode = stop === 0 ? 0 : 7;
        }
      }
      return { code: 0, stdout: JSON.stringify(frame), stderr: '' };
    }),
    cleanupFrozenOperation: vi.fn(async () => {}),
  };
  const provider = new DockerContainerProvider();
  vi.spyOn(provider, 'frozen', 'get').mockReturnValue(engine);
  const cases: ProposalRuntimeCase[] = prepared.checks.map(check => ({ checkId: check.id, checkDigest: digest(check),
    argv: check.kind === 'recovery' ? [...experiment.argv] : ['node', '/workspace/asset.js'], expected: { value: 'new' },
    ...(check.kind === 'recovery' ? { experiment: configured } : {}) }));
  const options: ProposalRuntimeOptions = { repository, request: { repository: workspace.repository, runId: workspace.runId },
    expectedCommit: commit, inventory, artifactPath: 'asset.js', baseImageId, scratchHelper: helper,
    binding: { scope: output.candidates[0].applicability.project, candidateId: 'd'.repeat(64), candidateVersion: 1, evidenceDigest: 'e'.repeat(64) },
    sandbox: { executeFrozen: vi.fn(async (request: FrozenExecutionOptions) => {
      requests.push(request);
      active = request;
      if (!request.scratch) return executeFrozenContainer(provider, request);
      const onContainer: ContainerRegistration = binding => {
        registrations.push(binding);
        expect(completed).toBe(false);
        expect(vi.mocked(engine.inspectFrozenContainer).mock.calls.length).toBe(vi.mocked(engine.startFrozenContainer).mock.calls.length * 2 + 1);
        if (registrationMode === 'missing') return;
        request.onContainer!({ ...binding, ...(registrationMode === 'operation' ? { operationId: 'foreign-operation' } : {}),
          ...(registrationMode === 'container' ? { containerId: 'f'.repeat(64) } : {}) });
        if (registrationMode === 'duplicate') request.onContainer!(binding);
      };
      return executeFrozenContainer(provider, { ...request, onContainer });
    }) },
    harness: { id: 'synthetic-recovery', revision: 'v1', kind: 'tool', cases,
      observe: vi.fn(async execution => ({ status: 'observed' as const, actual: JSON.parse(execution.stdout), assertions: 1 })) },
    assertCurrent: vi.fn(async () => {}), recordOwnership: vi.fn(async () => {}),
  };
  return { root, original, prepared, experiment, recoveryCheck, helper, repository, engine, options, requests, registrations,
    registration: (mode: RegistrationMode) => { registrationMode = mode; } };
}

async function observeRecovery(test: ReturnType<typeof fixture>) {
  const result = await verifyRepositoryAssetProposal(test.prepared, test.options);
  expect(result.status).toBe('verification-observed');
  if (result.status !== 'verification-observed') throw new Error('Expected synthetic recovery observations');
  const comparison = result.comparisons.find(entry => entry.checkId === test.recoveryCheck.id);
  if (!comparison?.original) throw new Error('Expected both recovery versions');
  return { result, observations: [comparison.original, comparison.proposed] };
}

function contextFor(observation: ProposalRuntimeObservation): ProposalSemanticExecutionContext {
  expect(observation.semanticContext).toBeDefined();
  if (!observation.semanticContext) throw new Error('Missing independently saved semantic context');
  return observation.semanticContext;
}

describe('proposal recovery runtime with synthetic frozen operations', () => {
  it.each([
    ['fault-exit', 'fault', 'exit-code', 1, 0], ['recovery-exit', 'recovery', 'exit-code', 2, 7],
    ['replay-exit', 'replay', 'exit-code', 3, 7], ['phase-output', 'recovery', 'phase-output', 3, 0],
    ['checkpoint', 'recovery', 'checkpoint', 3, 0],
  ] as const)('keeps the observed %s baseline and compares the proposal', async (mode, phase, reason, count, exitCode) => {
    const test = fixture(returns, mode);
    const { observations } = await observeRecovery(test);
    const [original, proposed] = observations as [ProposalRuntimeObservation, ProposalRuntimeObservation];
    expect(observations.map(item => [item.receipt.binding.version, item.receipt.passed])).toEqual([['original', false], ['proposed', true]]);
    const failure = original.execution.evidence.scratch!.baselineFailure!;
    expect(original.receipt.semantic?.baselineFailure).toEqual({ phase, reason, phasesObserved: count, observedExitCode: exitCode,
      expectedExitCode: returns[phase].exitCode, evidenceDigest: digest(failure) });
    expect(original.execution.evidence.scratch!.recovery).toBeUndefined();
    expect(failure.phases.map(entry => entry.phase)).toEqual(names.slice(0, count));
    expect(proposed.execution.evidence.scratch!.recovery!.qualification).toBe('qualified-bounded-returns-and-state');
    if (mode === 'checkpoint') expect(original.receipt.semantic!.assertions.every(assertion => assertion.passed)).toBe(true);
    const context = contextFor(original);
    expect(() => verifyFrozenScratchRecoveryEvidence(context.options, failure, context.operationId, context.containerId)).toThrow();
    const changed = { ...original.execution.evidence.scratch!, baselineFailure: { ...failure, contractDigest: '0'.repeat(64) } };
    expect(() => observeProposalExperiment(test.experiment, { ...original.execution,
      evidence: { ...original.execution.evidence, scratch: changed } }, context)).toThrow();
  });

  it.each(['observer-stderr', 'foreign-frame'] as const)('stops the comparison on %s', async mode => {
    const test = fixture(returns, mode);
    await expect(verifyRepositoryAssetProposal(test.prepared, test.options)).rejects.toThrow(/scratch/i);
    expect(test.requests.filter(request => request.scratch).map(request => request.scratch!.candidateVersion)).toEqual(['original']);
    expect(test.repository.cleanup).toHaveBeenCalledOnce();
  });

  it('observes original and proposed recovery with owned helper and independently saved options and identities', async () => {
    const test = fixture();
    const { result, observations } = await observeRecovery(test);
    expect(observations.map(observation => observation.receipt.binding.version)).toEqual(['original', 'proposed']);
    for (const observation of observations) {
      const context = contextFor(observation);
      const { execution, receipt } = observation;
      expect(receipt.passed).toBe(true);
      expect(receipt.semantic?.passed).toBe(true);
      expect(execution.exitCode).toBe(0);
      expect(context.operationId).toBe(execution.evidence.operationId);
      expect(context.containerId).toBe(execution.evidence.containerId);
      expect(test.registrations).toContainEqual({ operationId: context.operationId, containerId: context.containerId });
      expect(test.options.recordOwnership).toHaveBeenCalledWith(expect.objectContaining({ operationId: context.operationId }),
        expect.anything(), expect.objectContaining({ version: receipt.binding.version, checkId: test.recoveryCheck.id }));
      expect(test.requests).toContain(context.options);
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.options)).toBe(true);
      expect(context.options.scratch?.helper).toBe(test.helper);
      expect(() => assertFrozenScratchHelper(context.options.scratch!.helper)).not.toThrow();
      expect(context.options.scratch).toMatchObject({ artifactPath: 'asset.js', candidateVersion: receipt.binding.version,
        callInput: faultInput, recovery: { callInput: recoveryInput, requireEffectHistory: false } });
      expect(context.options.argv).toEqual(['node', 'asset.js', faultInput]);
      const evidence = execution.evidence.scratch!.recovery!;
      expect(evidence).toMatchObject({ revision: 'linux-native-scratch-recovery-v2', helperRevision: 'linux-native-scratch-recovery-v1',
        contractRevision: 'bounded-recovery-return-state-v1', qualification: 'qualified-bounded-returns-and-state',
        returnAssertionsMatched: true, historyCoverage: 'not-observed' });
      expect(evidence.phases.map(phase => phase.invocation.exitCode)).toEqual([23, 0, 0]);
      expect(verifyFrozenScratchRecoveryEvidence(context.options, evidence, context.operationId, context.containerId)).toEqual(evidence);
      expect(observeProposalExperiment(test.experiment, execution, context)).toEqual(receipt.semantic);
      expect(receipt).not.toHaveProperty('semanticContext');
      expect(JSON.stringify(receipt)).not.toContain('"semanticContext"');
    }
    expect(observations[0]!.execution.evidence.inputDigest).not.toBe(observations[1]!.execution.evidence.inputDigest);
    expect(new Set(observations.map(observation => contextFor(observation).operationId)).size).toBe(2);
    expect(result.comparisons).toHaveLength(test.prepared.checks.length);
    expect(test.options.harness!.observe).toHaveBeenCalledTimes((test.prepared.checks.length - 1) * 2);
    expect(test.repository.cleanup).toHaveBeenCalledOnce();
    expect(readFileSync(join(test.root, 'asset.js'), 'utf8')).toBe(test.original);
    expect(readFileSync(join(test.root, 'untouched.txt'), 'utf8')).toBe('baseline');
    expect(git(test.root, 'status', '--porcelain')).toBe('');
  });

  it('keeps independent phase decoding when raw bytes could form a character across invocations', async () => {
    const test = fixture({ fault: { ...returns.fault, stdoutHex: 'e2' },
      recovery: { ...returns.recovery, stdoutHex: '82ac' }, replay: { ...returns.replay, stdoutHex: 'ff' } });
    const { observations } = await observeRecovery(test);
    for (const observation of observations) {
      expect(observation.execution.stdout).toBe('\uFFFD\uFFFD\uFFFD\uFFFD');
      expect(observation.receipt.passed).toBe(true);
      expect(() => observeProposalExperiment(test.experiment, { ...observation.execution, stdout: '\u20AC\uFFFD' },
        contextFor(observation))).toThrow(/output/i);
    }
  });

  it('binds the sandbox cap and freshly computed remaining budget into both recovery contracts', async () => {
    const test = fixture();
    const remainingMs = vi.fn().mockReturnValue(900).mockReturnValueOnce(480).mockReturnValueOnce(180.9);
    test.options.sandbox.limits = { timeoutMs: 350, maxOutputBytes: 1024 };
    test.options.sandbox.remainingMs = remainingMs;
    const { observations } = await observeRecovery(test);
    expect(remainingMs).toHaveBeenCalledTimes(test.requests.length);
    expect(observations.map(observation => contextFor(observation).options.timeoutMs)).toEqual([350, 180]);
    for (const observation of observations) {
      const context = contextFor(observation);
      expect(context.options.maxOutputBytes).toBe(1024);
      const started = vi.mocked(test.engine.startFrozenContainer).mock.calls.find(call => call[0] === context.containerId);
      expect(started?.[1].timeoutMs).toBe(context.options.timeoutMs);
      expect(observation.execution.evidence.argv.slice(12, 14)).toEqual([String(context.options.timeoutMs), '1024']);
      const evidence = observation.execution.evidence.scratch!.recovery!;
      for (const changed of [{ ...context.options, timeoutMs: context.options.timeoutMs + 1 },
        { ...context.options, maxOutputBytes: 1025 }]) {
        expect(() => verifyFrozenScratchRecoveryEvidence(changed, evidence, context.operationId, context.containerId)).toThrow();
        expect(() => observeProposalExperiment(test.experiment, observation.execution, { ...context, options: changed })).toThrow();
      }
    }
  });

  it('stops before allocation when the remaining execution budget is exhausted', async () => {
    const test = fixture();
    test.options.sandbox.remainingMs = vi.fn(() => 0);
    await expect(verifyRepositoryAssetProposal(test.prepared, test.options)).rejects.toThrow(/deadline/i);
    expect(test.options.sandbox.executeFrozen).not.toHaveBeenCalled();
    expect(test.engine.buildFrozenImage).not.toHaveBeenCalled();
    expect(test.repository.cleanup).toHaveBeenCalledOnce();
  });

  it('enforces the configured business-output budget before allocating a recovery container', async () => {
    const test = fixture();
    const required = Object.values(returns).reduce((total, returned) => total + (returned.stdoutHex.length + returned.stderrHex.length) / 2, 0);
    test.options.sandbox.limits = { timeoutMs: 350, maxOutputBytes: required - 1 };
    await expect(verifyRepositoryAssetProposal(test.prepared, test.options)).rejects.toThrow(/scratch|returns|bound/i);
    expect(test.requests).toHaveLength(1);
    expect(test.engine.buildFrozenImage).not.toHaveBeenCalled();
    expect(test.repository.cleanup).toHaveBeenCalledOnce();
  });

  it.each(['missing', 'operation', 'container', 'duplicate'] as const)('rejects %s independent container registration', async mode => {
    const test = fixture();
    test.registration(mode);
    await expect(verifyRepositoryAssetProposal(test.prepared, test.options)).rejects.toThrow(/container|ownership|identity/i);
    expect(test.engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
    expect(test.repository.cleanup).toHaveBeenCalledOnce();
    expect(test.engine.startFrozenContainer).toHaveBeenCalledTimes(mode === 'operation' || mode === 'duplicate' ? 0 : 1);
  });

  it('requires provisioning the owned captured helper before repository execution', async () => {
    const test = fixture();
    const missing = await verifyRepositoryAssetProposal(test.prepared, { ...test.options, scratchHelper: undefined });
    expect(missing).toEqual({ status: 'blocked', code: 'oracle_unsupported', observations: [] });
    await expect(verifyRepositoryAssetProposal(test.prepared, { ...test.options, scratchHelper: { ...test.helper } })).rejects.toThrow(/helper.*owned/i);
    expect(test.repository.prepare).not.toHaveBeenCalled();
    expect(test.engine.buildFrozenImage).not.toHaveBeenCalled();
  });

  it('revalidates recovery only against independent context, exact options and owned helper identity', async () => {
    const test = fixture();
    const { observations } = await observeRecovery(test);
    const observation = observations[0]!;
    const context = contextFor(observation);
    const scratch = context.options.scratch!;
    expect(observeProposalExperiment(test.experiment, observation.execution, context).passed).toBe(true);
    expect(() => observeProposalExperiment(test.experiment, observation.execution)).toThrow();
    const changedOptions: FrozenExecutionOptions[] = [
      { ...context.options, timeoutMs: context.options.timeoutMs + 1 },
      { ...context.options, maxOutputBytes: context.options.maxOutputBytes! - 1 },
      { ...context.options, baseImageId: `sha256:${'c'.repeat(64)}` },
      { ...context.options, input: contextFor(observations[1]!).options.input },
      { ...context.options, scratch: { ...scratch, helper: { ...test.helper } } },
      { ...context.options, scratch: { ...scratch, candidateVersion: 'proposed' } },
      { ...context.options, argv: ['node', 'asset.js', recoveryInput], scratch: { ...scratch, callInput: recoveryInput } },
      { ...context.options, scratch: { ...scratch, recovery: { ...scratch.recovery!, returnAssertions: {
        ...returns, replay: { ...returns.replay, stderrHex: '00' },
      } } } },
    ];
    for (const [index, options] of changedOptions.entries()) {
      expect(() => observeProposalExperiment(test.experiment, observation.execution, { ...context, options }), `changed options ${index}`).toThrow();
    }
  });

  it('rejects drifted outer outputs, saved phase bytes and both independent identities', async () => {
    const test = fixture();
    const { observations } = await observeRecovery(test);
    const observation = observations[0]!;
    const context = contextFor(observation);
    expect(observeProposalExperiment(test.experiment, observation.execution, context).passed).toBe(true);
    for (const changed of [{ ...context, operationId: 'foreign-operation' }, { ...context, containerId: 'f'.repeat(64) },
      contextFor(observations[1]!)]) {
      expect(() => observeProposalExperiment(test.experiment, observation.execution, changed)).toThrow();
    }
    const changedExecutions: FrozenExecutionResult[] = [
      { ...observation.execution, stdout: 'drifted\n' },
      { ...observation.execution, stderr: 'drifted\n' },
      { ...observation.execution, exitCode: 23 },
      { ...observation.execution, evidence: { ...observation.execution.evidence, operationId: 'foreign-operation' } },
      { ...observation.execution, evidence: { ...observation.execution.evidence, containerId: 'f'.repeat(64) } },
    ];
    const phaseDrift: FrozenExecutionResult = JSON.parse(JSON.stringify(observation.execution));
    Object.assign(phaseDrift.evidence.scratch!.recovery!.phases[2]!, { stdoutHex: Buffer.from('drifted\n').toString('hex') });
    changedExecutions.push(phaseDrift);
    for (const [index, execution] of changedExecutions.entries()) {
      expect(() => observeProposalExperiment(test.experiment, execution, context), `changed execution ${index}`).toThrow();
    }
  });

  it('keeps the mandatory permission semantic case unsupported despite a complete recovery contract', async () => {
    const test = fixture();
    const permission = test.prepared.checks.find(check => check.kind === 'permission-denied')!;
    const configured = test.options.harness!.cases.find(check => check.checkId === permission.id)!;
    configured.experiment = { protocol: 'proposal-semantic-v1', adapter: 'node-json-argv-v1', kind: 'permission-denied', input: permission.input,
      assertions: [{ id: 'permission-exit', source: 'exit-code', expected: 1 }, { id: 'permission-refusal', source: 'stderr', expected: 'denied' }] };
    expect(prepareProposalExperiment('tool', 'asset.js', permission, configured.experiment)).toMatchObject({ status: 'unsupported' });
    const result = await verifyRepositoryAssetProposal(test.prepared, test.options);
    expect(result).toEqual({ status: 'blocked', code: 'oracle_unsupported', observations: [] });
    expect(test.repository.prepare).not.toHaveBeenCalled();
    expect(test.options.sandbox.executeFrozen).not.toHaveBeenCalled();
    expect(test.engine.buildFrozenImage).not.toHaveBeenCalled();
  });
});
