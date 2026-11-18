import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { assertFrozenScratchHelper, buildFrozenContext, type CapturedFrozenInput, type CapturedFrozenScratchHelper } from './frozen-input.js';
import type { ContainerProvider, FrozenCommandOptions, FrozenContainerInspection, FrozenContainerOperations, FrozenScratchAssertion, FrozenScratchEvidence, FrozenScratchRecoveryEvidence, FrozenScratchRecoveryRequest, FrozenScratchResource, FrozenScratchSnapshot } from './types.js';

export interface FrozenScratchObservation {
  readonly helper: CapturedFrozenScratchHelper;
  readonly artifactPath: string;
  readonly candidateVersion: 'original' | 'proposed';
  readonly callInput: string;
  readonly resources: readonly FrozenScratchResource[];
  readonly recovery?: FrozenScratchRecoveryRequest;
}

export interface FrozenExecutionOptions {
  readonly input: CapturedFrozenInput;
  readonly baseImageId: string;
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
  readonly control?: { readonly kind: 'cancellation' | 'timeout'; readonly afterMs: number };
  readonly scratch?: FrozenScratchObservation;
  readonly onOwnership?: (ownership: FrozenExecutionOwnership) => void | Promise<void>;
  readonly onContainer?: (binding: Readonly<{ operationId: string; containerId: string }>) => void;
}

export interface FrozenExecutionOwnership {
  readonly operationId: string;
  readonly engine: 'docker';
  readonly containerName: string;
  readonly baseImageId: string;
  readonly inputDigest: string;
  readonly contextDigest: string;
}

export class FrozenCleanupError extends AggregateError {
  constructor(readonly ownership: FrozenExecutionOwnership, errors: readonly unknown[], cause: unknown) {
    super(errors, 'Frozen execution cleanup could not be confirmed', { cause });
  }
}

export type FrozenControlEvidence = {
  readonly kind: 'cancellation' | 'timeout';
  readonly afterMs: number;
  readonly operationId: string;
  readonly containerId: string;
  readonly terminatedMs: number;
} & (
  | { readonly outcome: 'triggered'; readonly trigger: 'host-cancellation' | 'host-deadline'; readonly signal: 'SIGKILL';
      readonly exitCode: 137; readonly runningObservedMs: number; readonly triggeredMs: number }
  | { readonly outcome: 'not-triggered'; readonly reason: 'early-exit'; readonly trigger: null; readonly signal: null;
      readonly exitCode: number; readonly runningObservedMs: number | null; readonly triggeredMs: null }
);

export interface FrozenExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly evidence: {
    readonly operationId: string;
    readonly containerId: string;
    readonly baseImageId: string;
    readonly imageId: string;
    readonly inputDigest: string;
    readonly contextDigest: string;
    readonly commandDigest: string;
    readonly policyDigest: string;
    readonly mechanism: 'docker-frozen-image';
    readonly argv: readonly string[];
    readonly cwd: '/workspace';
    readonly durationMs: number;
    readonly scratch?: FrozenScratchEvidence;
    readonly control?: FrozenControlEvidence;
    readonly policy: FrozenContainerInspection;
  };
  readonly cleanup: { readonly containerRemoved: true; readonly imageRemoved: true };
}

const scratchDigest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

function scratchExact<Key extends string>(value: unknown, keys: readonly Key[]): asserts value is { [Field in Key]: unknown } {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error('Invalid frozen scratch schema');
}

function validateScratch(options: FrozenExecutionOptions): void {
  const scratch = options.scratch!;
  assertFrozenScratchHelper(scratch.helper);
  scratchExact(scratch, ['helper', 'artifactPath', 'candidateVersion', 'callInput', 'resources', ...(scratch.recovery === undefined ? [] : ['recovery'])]);
  if (options.control || !['original', 'proposed'].includes(scratch.candidateVersion)
    || typeof scratch.callInput !== 'string' || Buffer.byteLength(scratch.callInput) > 16 * 1024
    || options.argv.length !== 3 || !['node', '/usr/local/bin/node'].includes(options.argv[0]!)
    || options.argv[1] !== scratch.artifactPath || options.argv[2] !== scratch.callInput
    || scratch.artifactPath.startsWith('-')
    || !options.input.manifest.some(entry => entry.kind === 'file' && entry.path === scratch.artifactPath)
    || !Array.isArray(scratch.resources) || !scratch.resources.length || scratch.resources.length > 4
    || (options.maxOutputBytes ?? 64 * 1024) > 64 * 1024) throw new Error('Invalid frozen scratch experiment or candidate binding');
  for (const resource of scratch.resources) {
    scratchExact(resource, ['id', 'path']);
    if (typeof resource.id !== 'string' || typeof resource.path !== 'string'
      || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,31}$/.test(resource.id) || resource.path.length > 64
      || !resource.path.split('/').every(segment => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(segment))) throw new Error('Invalid frozen scratch resource');
  }
  if (new Set(scratch.resources.map(resource => resource.id)).size !== scratch.resources.length
    || new Set(scratch.resources.map(resource => resource.path)).size !== scratch.resources.length) throw new Error('Duplicate frozen scratch resource');
  if (scratch.recovery !== undefined) {
    const recovery = scratch.recovery;
    scratchExact(recovery, ['callInput', 'requireEffectHistory', 'assertions', ...(recovery.returnAssertions === undefined ? [] : ['returnAssertions'])]);
    if (typeof recovery.callInput !== 'string' || recovery.callInput.includes('\0') || Buffer.byteLength(recovery.callInput) > 16 * 1024
      || recovery.callInput === scratch.callInput || typeof recovery.requireEffectHistory !== 'boolean') throw new Error('Invalid frozen scratch recovery input');
    scratchExact(recovery.assertions, ['fault', 'recovered', 'replayed']);
    for (const expected of Object.values(recovery.assertions)) {
      if (!Array.isArray(expected) || expected.length !== scratch.resources.length) throw new Error('Invalid frozen scratch recovery assertions');
      expected.forEach((record: unknown, index: number) => {
        scratchExact(record, ['id', 'path', 'bytes']);
        if (record.id !== scratch.resources[index]!.id || record.path !== scratch.resources[index]!.path
          || record.bytes !== null && (typeof record.bytes !== 'string' || record.bytes.length > 4 * Math.ceil(16 * 1024 / 3)
            || Buffer.from(record.bytes, 'base64').length > 16 * 1024 || Buffer.from(record.bytes, 'base64').toString('base64') !== record.bytes)) {
          throw new Error('Invalid frozen scratch recovery assertion bytes or identity');
        }
      });
    }
    if (!recovery.assertions.fault.some(record => record.bytes !== null)
      || !recovery.assertions.fault.some((record, index) => record.bytes !== recovery.assertions.recovered[index]!.bytes)
      || recovery.assertions.recovered.some((record, index) => record.bytes !== recovery.assertions.replayed[index]!.bytes)) {
      throw new Error('Frozen scratch recovery must distinguish a fault and assert terminal-state idempotency');
    }
    if (recovery.returnAssertions !== undefined) {
      scratchExact(recovery.returnAssertions, ['fault', 'recovery', 'replay']);
      const limit = options.maxOutputBytes ?? 64 * 1024;
      let outputBytes = 0;
      for (const phase of ['fault', 'recovery', 'replay'] as const) {
        const expected: unknown = recovery.returnAssertions[phase];
        scratchExact(expected, ['exitCode', 'signal', 'stdoutHex', 'stderrHex']);
        if (typeof expected.exitCode !== 'number' || !Number.isSafeInteger(expected.exitCode) || expected.signal !== null
          || (phase === 'fault' ? expected.exitCode < 1 || expected.exitCode > 255 : expected.exitCode !== 0)) {
          throw new Error('Invalid frozen scratch recovery return outcome');
        }
        for (const bytes of [expected.stdoutHex, expected.stderrHex]) {
          if (typeof bytes !== 'string' || bytes.length > limit * 2 || !/^(?:[a-f0-9]{2})*$/.test(bytes)) {
            throw new Error('Invalid frozen scratch recovery return bytes');
          }
          outputBytes += bytes.length / 2;
        }
      }
      if (outputBytes > limit) throw new Error('Frozen scratch recovery saved returns exceed session bound');
    }
  }
}

function scratchRecoveryContractDigest(options: FrozenExecutionOptions): string {
  const scratch = options.scratch!;
  const recovery = scratch.recovery!;
  const records = (assertions: readonly FrozenScratchAssertion[]) => assertions.map(({ id, path, bytes }) => ({ id, path, bytes }));
  const returns = (expected: NonNullable<FrozenScratchRecoveryRequest['returnAssertions']>['fault']) => ({
    exitCode: expected.exitCode, signal: expected.signal, stdoutHex: expected.stdoutHex, stderrHex: expected.stderrHex,
  });
  return scratchDigest(JSON.stringify({ revision: 'bounded-recovery-return-state-v1', helperRevision: 'linux-native-scratch-recovery-v1',
    inputDigest: options.input.digest, helperDigest: scratch.helper.digest,
    artifactDigest: options.input.manifest.find(entry => entry.path === scratch.artifactPath)!.digest,
    candidateVersion: scratch.candidateVersion, argv: [...options.argv], faultCallInput: scratch.callInput, callInput: recovery.callInput,
    resources: scratch.resources.map(({ id, path }) => ({ id, path })),
    assertions: { fault: records(recovery.assertions.fault), recovered: records(recovery.assertions.recovered), replayed: records(recovery.assertions.replayed) },
    returnAssertions: recovery.returnAssertions === undefined ? null : { fault: returns(recovery.returnAssertions.fault),
      recovery: returns(recovery.returnAssertions.recovery), replay: returns(recovery.returnAssertions.replay) },
    requireEffectHistory: recovery.requireEffectHistory, timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes ?? 64 * 1024,
  }));
}

export function frozenExecutionArgv(options: FrozenExecutionOptions, operationId: string): readonly string[] {
  if (!options.scratch) return Object.freeze([...options.argv]);
  const scratch = options.scratch!;
  const artifact = options.input.manifest.find(entry => entry.path === scratch.artifactPath)!;
  return Object.freeze(['/afk-observer/scratch-v1', operationId, options.input.digest, scratch.helper.digest, artifact.digest,
    scratchDigest(scratch.callInput), scratch.candidateVersion, String(options.timeoutMs), String(options.maxOutputBytes ?? 64 * 1024),
    String(scratch.resources.length), ...scratch.resources.flatMap(resource => [resource.id, resource.path]),
    ...(scratch.recovery ? ['--recovery', scratchDigest(scratch.recovery.callInput), scratch.recovery.callInput] : []), '--', ...options.argv]);
}

function scratchFrame(frame: unknown, options: FrozenExecutionOptions, operationId: string, containerId: string,
  continued = false): { stdout: string; stderr: string; evidence: FrozenScratchEvidence } {
  scratchExact(frame, ['revision', 'operationId', 'inputDigest', 'helperDigest', 'artifactDigest', 'callInputDigest', 'candidateVersion',
    'invocation', 'initialSampledMs', 'sampledMs', 'initial', 'final', 'stdoutHex', 'stderrHex']);
  const scratch = options.scratch!;
  const artifactDigest = options.input.manifest.find(entry => entry.path === scratch.artifactPath)!.digest;
  if (frame.revision !== 'linux-native-scratch-v1' || frame.operationId !== operationId || frame.inputDigest !== options.input.digest
    || frame.helperDigest !== scratch.helper.digest || frame.artifactDigest !== artifactDigest
    || frame.callInputDigest !== scratchDigest(scratch.callInput) || frame.candidateVersion !== scratch.candidateVersion) throw new Error('Frozen scratch identity differs');
  const invocation = frame.invocation;
  scratchExact(invocation, ['pid', 'startedIdentity', 'execConfirmed', 'startedMs', 'finishedMs', 'exitCode', 'signal']);
  const boundedTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= options.timeoutMs;
  if (!Number.isSafeInteger(invocation.pid) || (invocation.pid as number) <= 1 || (invocation.pid as number) > 4194304
    || typeof invocation.startedIdentity !== 'string' || !/^[1-9][0-9]{0,19}$/.test(invocation.startedIdentity) || invocation.execConfirmed !== true
    || !boundedTime(frame.initialSampledMs) || !boundedTime(invocation.startedMs) || !boundedTime(invocation.finishedMs) || !boundedTime(frame.sampledMs)
    || frame.initialSampledMs > invocation.startedMs || invocation.startedMs > invocation.finishedMs || invocation.finishedMs > frame.sampledMs
    || !(invocation.signal === null && Number.isInteger(invocation.exitCode) && (invocation.exitCode as number) >= 0 && (invocation.exitCode as number) <= 255
      || invocation.exitCode === null && Number.isInteger(invocation.signal) && (invocation.signal as number) >= 1 && (invocation.signal as number) <= 64)) throw new Error('Frozen scratch invocation was not authenticated');
  const decode = (value: unknown, limit: number): Buffer => {
    if (typeof value !== 'string' || value.length > limit * 2 || !/^(?:[a-f0-9]{2})*$/.test(value)) throw new Error('Invalid frozen scratch bytes');
    return Buffer.from(value, 'hex');
  };
  const snapshot = (records: unknown, phase: 'initial' | 'final'): FrozenScratchSnapshot => {
    if (!Array.isArray(records) || records.length !== scratch.resources.length) throw new Error('Frozen scratch resource coverage differs');
    const resources = records.map((record: unknown, index: number) => {
      scratchExact(record, ['id', 'path', 'present', 'hex']);
      const resource = scratch.resources[index]!;
      if (record.id !== resource.id || record.path !== resource.path || typeof record.present !== 'boolean'
        || !record.present && record.hex !== null || phase === 'initial' && !continued && record.present) throw new Error('Frozen scratch resource identity or initial state differs');
      const bytes = record.present ? decode(record.hex, 16 * 1024) : null;
      return { ...resource, present: record.present, size: bytes?.length ?? 0, digest: bytes ? scratchDigest(bytes) : null, bytes: bytes?.toString('base64') ?? null };
    });
    return { sampledMs: (phase === 'initial' ? frame.initialSampledMs : frame.sampledMs) as number,
      processState: phase === 'initial' && !continued ? 'not-started' : 'exited', quiescenceConfirmed: true,
      stateDigest: scratchDigest(JSON.stringify(resources)), resources };
  };
  const stdout = decode(frame.stdoutHex, options.maxOutputBytes ?? 64 * 1024);
  const stderr = decode(frame.stderrHex, options.maxOutputBytes ?? 64 * 1024);
  if (stdout.length + stderr.length > (options.maxOutputBytes ?? 64 * 1024)) throw new Error('Frozen scratch candidate output exceeds bound');
  return { stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), evidence: {
    revision: 'linux-native-scratch-v1', operationId, containerId, inputDigest: options.input.digest, helperDigest: scratch.helper.digest,
    artifactDigest, callInputDigest: scratchDigest(scratch.callInput), argvDigest: scratchDigest(JSON.stringify(options.argv)),
    candidateVersion: scratch.candidateVersion, invocation: invocation as unknown as FrozenScratchEvidence['invocation'],
    initial: snapshot(frame.initial, 'initial'), final: snapshot(frame.final, 'final'), historyCoverage: 'not-observed',
  } };
}

function scratchResult(result: { stdout: string; stderr: string; code: number }, options: FrozenExecutionOptions,
  operationId: string, containerId: string): { stdout: string; stderr: string; evidence: FrozenScratchEvidence } {
  if (result.code !== 0 || result.stderr !== '' || Buffer.byteLength(result.stdout) > 512 * 1024) throw new Error('Frozen scratch helper did not complete safely');
  let frame: unknown;
  try { frame = JSON.parse(result.stdout); } catch { throw new Error('Invalid frozen scratch helper frame'); }
  const scratch = options.scratch!;
  const recovery = scratch.recovery;
  if (!recovery) return scratchFrame(frame, options, operationId, containerId);
  return scratchRecoveryFrame(frame, options, operationId, containerId);
}

function scratchRecoveryFrame(frame: unknown, options: FrozenExecutionOptions,
  operationId: string, containerId: string): { stdout: string; stderr: string; evidence: FrozenScratchEvidence } {
  const scratch = options.scratch!;
  const recovery = scratch.recovery!;
  scratchExact(frame, ['revision', 'operationId', 'inputDigest', 'helperDigest', 'artifactDigest', 'candidateVersion', 'initialSampledMs', 'initial', 'phases']);
  if (frame.revision !== 'linux-native-scratch-recovery-v1' || !Array.isArray(frame.phases) || frame.phases.length !== 3) throw new Error('Invalid frozen scratch recovery phases');
  const names = ['fault', 'recovery', 'replay'] as const;
  const assertions = [recovery.assertions.fault, recovery.assertions.recovered, recovery.assertions.replayed];
  const phases: FrozenScratchRecoveryEvidence['phases'][number][] = [];
  const identities = new Set<string>();
  const output = { stdout: '', stderr: '' };
  let outputBytes = 0;
  let firstEvidence: FrozenScratchEvidence | undefined;
  let previous = frame.initial;
  let sampledMs = frame.initialSampledMs;
  for (const [index, phase] of frame.phases.entries()) {
    scratchExact(phase, ['phase', 'ordinal', 'invocationId', 'callInputDigest', 'invocation', 'sampledMs', 'final', 'stdoutHex', 'stderrHex']);
    if (phase.phase !== names[index] || phase.ordinal !== index + 1 || phase.invocationId !== `${operationId}:${index + 1}`) throw new Error('Frozen scratch recovery invocation identity differs');
    const callInput = index === 0 ? scratch.callInput : recovery.callInput;
    const observed = scratchFrame({ revision: 'linux-native-scratch-v1', operationId: frame.operationId, inputDigest: frame.inputDigest,
      helperDigest: frame.helperDigest, artifactDigest: frame.artifactDigest, candidateVersion: frame.candidateVersion,
      callInputDigest: phase.callInputDigest, invocation: phase.invocation, initialSampledMs: sampledMs, initial: previous,
      sampledMs: phase.sampledMs, final: phase.final, stdoutHex: phase.stdoutHex, stderrHex: phase.stderrHex },
    { ...options, argv: [options.argv[0]!, scratch.artifactPath, callInput], scratch: { ...scratch, callInput } }, operationId, containerId, index > 0);
    const invocation = observed.evidence.invocation;
    firstEvidence ??= observed.evidence;
    const identity = `${invocation.pid}:${invocation.startedIdentity}`;
    if (identities.has(identity) || (index === 0 ? invocation.exitCode === 0 : invocation.exitCode !== 0)
      || observed.evidence.final.resources.some((resource, resourceIndex) => resource.bytes !== assertions[index]![resourceIndex]!.bytes)) {
      throw new Error('Frozen scratch recovery process or saved assertions differ');
    }
    const expected = recovery.returnAssertions?.[names[index]!];
    if (expected && (invocation.exitCode !== expected.exitCode || invocation.signal !== expected.signal
      || phase.stdoutHex !== expected.stdoutHex || phase.stderrHex !== expected.stderrHex)) {
      throw new Error('Frozen scratch recovery saved returns differ');
    }
    identities.add(identity);
    outputBytes += ((phase.stdoutHex as string).length + (phase.stderrHex as string).length) / 2;
    if (outputBytes > (options.maxOutputBytes ?? 64 * 1024)) throw new Error('Frozen scratch recovery output exceeds session bound');
    output.stdout += observed.stdout;
    output.stderr += observed.stderr;
    phases.push({ ...observed.evidence, phase: names[index]!, ordinal: index + 1, invocationId: phase.invocationId,
      stdoutHex: phase.stdoutHex as string, stderrHex: phase.stderrHex as string });
    previous = phase.final;
    sampledMs = phase.sampledMs;
  }
  const boundaries = { initial: phases[0]!.initial, fault: phases[0]!.final, recovered: phases[1]!.final, replayed: phases[2]!.final };
  if (boundaries.recovered.stateDigest !== boundaries.replayed.stateDigest) throw new Error('Frozen scratch replay changed terminal state');
  const returnAssertionsMatched = recovery.returnAssertions !== undefined;
  return { ...output, evidence: { ...firstEvidence!, recovery: { revision: 'linux-native-scratch-recovery-v2',
    helperRevision: 'linux-native-scratch-recovery-v1', contractRevision: 'bounded-recovery-return-state-v1',
    contractDigest: scratchRecoveryContractDigest(options), phases, boundaries,
    assertionsDigest: scratchDigest(JSON.stringify(recovery.assertions)), assertionsMatched: true, returnAssertionsMatched, terminalStateIdempotent: true,
    trajectoryCoverage: 'observed-phase-boundaries', replayBehaviorCoverage: returnAssertionsMatched ? 'observed-phase-returns' : 'not-observed',
    historyCoverage: 'not-observed', qualification: recovery.requireEffectHistory ? 'unsupported-effect-history'
      : returnAssertionsMatched ? 'qualified-bounded-returns-and-state' : 'unsupported-replay-behavior' } } };
}

export function verifyFrozenScratchRecoveryEvidence(options: FrozenExecutionOptions, evidence: unknown,
  operationId: string, containerId: string): FrozenScratchRecoveryEvidence {
  if (!options.scratch?.recovery || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000
    || !Number.isSafeInteger(options.maxOutputBytes ?? 64 * 1024) || (options.maxOutputBytes ?? 64 * 1024) < 1
    || typeof operationId !== 'string' || !operationId || typeof containerId !== 'string' || !containerId) {
    throw new Error('Invalid frozen scratch recovery verification binding');
  }
  validateScratch(options);
  const artifact = options.input.manifest.find(entry => entry.path === options.scratch!.artifactPath)!;
  if ([options.input.digest, options.scratch.helper.digest, artifact.digest].some(value => !/^[a-f0-9]{64}$/.test(value))) {
    throw new Error('Invalid frozen scratch recovery verification digest');
  }
  scratchExact(evidence, ['revision', 'helperRevision', 'contractRevision', 'contractDigest', 'phases', 'boundaries', 'assertionsDigest',
    'assertionsMatched', 'returnAssertionsMatched', 'terminalStateIdempotent', 'trajectoryCoverage', 'replayBehaviorCoverage', 'historyCoverage', 'qualification']);
  if (evidence.revision !== 'linux-native-scratch-recovery-v2' || evidence.helperRevision !== 'linux-native-scratch-recovery-v1'
    || evidence.contractRevision !== 'bounded-recovery-return-state-v1' || !Array.isArray(evidence.phases) || evidence.phases.length !== 3) {
    throw new Error('Unsupported frozen scratch recovery evidence revision or phases');
  }
  const snapshot = (value: unknown) => {
    scratchExact(value, ['sampledMs', 'processState', 'quiescenceConfirmed', 'stateDigest', 'resources']);
    if (!Array.isArray(value.resources) || value.resources.length !== options.scratch!.resources.length) {
      throw new Error('Invalid frozen scratch recovery snapshot coverage');
    }
    return { sampledMs: value.sampledMs, resources: value.resources.map((record: unknown) => {
      scratchExact(record, ['id', 'path', 'present', 'size', 'digest', 'bytes']);
      if (record.bytes !== null && (typeof record.bytes !== 'string' || record.bytes.length > 4 * Math.ceil(16 * 1024 / 3)
        || Buffer.from(record.bytes, 'base64').length > 16 * 1024 || Buffer.from(record.bytes, 'base64').toString('base64') !== record.bytes)) {
        throw new Error('Invalid frozen scratch recovery snapshot bytes');
      }
      return { id: record.id, path: record.path, present: record.present,
        hex: record.bytes === null ? null : Buffer.from(record.bytes as string, 'base64').toString('hex') };
    }) };
  };
  const phases = evidence.phases.map((phase: unknown) => {
    scratchExact(phase, ['revision', 'operationId', 'containerId', 'inputDigest', 'helperDigest', 'artifactDigest', 'callInputDigest', 'argvDigest',
      'candidateVersion', 'invocation', 'initial', 'final', 'historyCoverage', 'phase', 'ordinal', 'invocationId', 'stdoutHex', 'stderrHex']);
    return { phase, initial: snapshot(phase.initial), final: snapshot(phase.final) };
  });
  const first = phases[0]!;
  const recomputed = scratchRecoveryFrame({ revision: 'linux-native-scratch-recovery-v1', operationId: first.phase.operationId,
    inputDigest: first.phase.inputDigest, helperDigest: first.phase.helperDigest, artifactDigest: first.phase.artifactDigest,
    candidateVersion: first.phase.candidateVersion, initialSampledMs: first.initial.sampledMs, initial: first.initial.resources,
    phases: phases.map(({ phase, final }) => ({ phase: phase.phase, ordinal: phase.ordinal, invocationId: phase.invocationId,
      callInputDigest: phase.callInputDigest, invocation: phase.invocation, sampledMs: final.sampledMs,
      final: final.resources, stdoutHex: phase.stdoutHex, stderrHex: phase.stderrHex })) }, options, operationId, containerId).evidence.recovery!;
  if (!isDeepStrictEqual(evidence, recomputed)) throw new Error('Frozen scratch recovery evidence differs from independent recomputation');
  return recomputed;
}

async function executeControlled(engine: FrozenContainerOperations, containerId: string, operationId: string,
  options: FrozenExecutionOptions, started: number, verify: (inspection: FrozenContainerInspection) => void): Promise<{
    result: { stdout: string; stderr: string; code: number }; completed: FrozenContainerInspection; control: FrozenControlEvidence;
  }> {
  const control = options.control!;
  const began = performance.now();
  const deadline = began + options.timeoutMs;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  let outcome: { result: { stdout: string; stderr: string; code: number } } | { error: unknown } | undefined;
  const bounded = (): FrozenCommandOptions => {
    if (options.signal?.aborted) throw options.signal.reason;
    const timeoutMs = Math.floor(deadline - performance.now());
    if (timeoutMs < 1) throw new Error('Frozen control execution deadline exceeded');
    return { signal: controller.signal, timeoutMs, maxOutputBytes: 256 * 1024 };
  };
  let pending: Promise<void> | undefined;
  let runningObservedMs: number | null = null;
  const wait = async (milliseconds: number) => {
    await new Promise<void>(resolve => { const timer = setTimeout(resolve, milliseconds); pending!.then(() => { clearTimeout(timer); resolve(); }); });
  };
  const exited = () => {
    bounded();
    if (outcome && 'error' in outcome) throw outcome.error;
    return outcome !== undefined;
  };
  const earlyExit = async () => {
    await pending;
    bounded();
    if (!outcome || 'error' in outcome) throw outcome && 'error' in outcome ? outcome.error : new Error('Frozen attach exit was not confirmed');
    const completed = await engine.inspectFrozenContainer(containerId, bounded());
    verify(completed);
    bounded();
    if (completed.status !== 'exited' || completed.exitCode !== outcome.result.code
      || !Number.isSafeInteger(completed.exitCode) || completed.exitCode < 0) throw new Error('Frozen early exit code or state was not confirmed');
    return { result: outcome.result, completed, control: { ...control, outcome: 'not-triggered' as const, reason: 'early-exit' as const,
      trigger: null, signal: null, operationId, containerId, exitCode: completed.exitCode,
      runningObservedMs, triggeredMs: null, terminatedMs: performance.now() - started } };
  };
  try {
    pending = engine.startFrozenContainer(containerId, { ...bounded(), maxOutputBytes: options.maxOutputBytes ?? 64 * 1024 })
      .then(result => { outcome = { result }; }, error => { outcome = { error }; });
    let inspected: FrozenContainerInspection;
    while (true) {
      if (exited()) return await earlyExit();
      inspected = await engine.inspectFrozenContainer(containerId, bounded());
      verify(inspected);
      bounded();
      if (inspected.status === 'running') { runningObservedMs = performance.now() - started; break; }
      if (exited() || inspected.status === 'exited') return await earlyExit();
      if (inspected.status !== 'created') throw new Error('Frozen control requires observed running container');
      await wait(Math.min(20, bounded().timeoutMs));
    }
    const triggerAt = started + runningObservedMs + control.afterMs;
    while (performance.now() < triggerAt) {
      if (exited()) return await earlyExit();
      await wait(Math.min(20, Math.max(1, Math.ceil(triggerAt - performance.now())), bounded().timeoutMs));
    }
    if (exited()) return await earlyExit();
    inspected = await engine.inspectFrozenContainer(containerId, bounded());
    verify(inspected);
    if (exited() || inspected.status === 'exited') return await earlyExit();
    if (inspected.status !== 'running') throw new Error('Frozen container stopped before control trigger');
    const triggeredMs = performance.now() - started;
    await engine.killFrozenContainer!(operationId, containerId, bounded());
    await pending;
    bounded();
    const completed = await engine.inspectFrozenContainer(containerId, bounded());
    verify(completed);
    if (!outcome || 'error' in outcome) throw outcome && 'error' in outcome ? outcome.error : new Error('Frozen controlled execution did not finish');
    if (completed.status !== 'exited' || completed.exitCode !== 137 || outcome.result.code !== 137) throw new Error('Frozen controlled termination exit was not confirmed');
    bounded();
    return { result: outcome.result, completed, control: { ...control, outcome: 'triggered',
      trigger: control.kind === 'timeout' ? 'host-deadline' as const : 'host-cancellation' as const,
      signal: 'SIGKILL' as const, operationId, containerId, exitCode: 137 as const,
      runningObservedMs, triggeredMs, terminatedMs: performance.now() - started } };
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abort);
    controller.abort();
    await pending;
  }
}

function assertPolicy(inspected: FrozenContainerInspection, operationId: string, containerId: string, imageId: string, argv: readonly string[]): void {
  if (inspected.id !== containerId || inspected.operationId !== operationId || inspected.imageId !== imageId
    || inspected.name !== `afk-frozen-${operationId}` || inspected.user !== '1000:1000' || !inspected.readOnlyRoot
    || inspected.network !== 'none' || inspected.privileged || inspected.pidMode !== '' || inspected.ipcMode !== 'private'
    || inspected.binds.length || inspected.mounts.some(mount => mount.type !== 'tmpfs' || mount.destination !== '/scratch')
    || JSON.stringify(inspected.capDrop) !== '["ALL"]' || JSON.stringify(inspected.securityOptions) !== '["no-new-privileges"]'
    || inspected.memory !== 268435456 || inspected.memorySwap !== 268435456 || inspected.nanoCpus !== 1_000_000_000 || inspected.pidsLimit !== 64
    || inspected.workdir !== '/workspace' || JSON.stringify(inspected.entrypoint) !== '["/usr/bin/env"]'
    || JSON.stringify(inspected.command) !== JSON.stringify(['-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/scratch', 'TMPDIR=/scratch', ...argv])
    || Object.keys(inspected.tmpfs).length !== 1 || inspected.tmpfs['/scratch'] !== 'rw,noexec,nosuid,nodev,size=16777216,mode=700,uid=1000,gid=1000') {
    throw new Error('Frozen container policy or execution identity differs from requested isolation');
  }
}

async function registerFrozenOwnership(options: FrozenExecutionOptions, ownership: FrozenExecutionOwnership, started: number): Promise<void> {
  if (!options.onOwnership) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      const expired = () => reject(new Error('Frozen ownership registration deadline exceeded'));
      const complete = () => {
        if (options.signal?.aborted) reject(options.signal.reason);
        else if (performance.now() - started >= options.timeoutMs) expired();
        else resolve();
      };
      abort = () => reject(options.signal?.reason);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) { abort(); return; }
      const remaining = options.timeoutMs - (performance.now() - started);
      if (remaining <= 0) { expired(); return; }
      timer = setTimeout(expired, remaining);
      try { Promise.resolve(options.onOwnership!(ownership)).then(complete, reject); }
      catch (error) { reject(error); }
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

export async function executeFrozenContainer(provider: ContainerProvider, options: FrozenExecutionOptions): Promise<FrozenExecutionResult> {
  options = { ...options, argv: Object.freeze([...options.argv]), ...(options.control === undefined ? {} : { control: Object.freeze({ ...options.control }) }),
    ...(options.scratch === undefined ? {} : { scratch: Object.freeze({ ...options.scratch,
      resources: Object.freeze(options.scratch.resources.map(resource => Object.freeze({ ...resource }))) }) }) };
  const checkAbort = () => { if (options.signal?.aborted) throw options.signal.reason; };
  checkAbort();
  if (provider.engine !== 'docker' || !provider.frozen) throw new Error('Provider has no supported frozen execution capability');
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000
    || !options.argv.length || !options.argv[0]?.trim() || options.argv.length > 128 || options.argv.some(argument => typeof argument !== 'string' || argument.includes('\0'))
    || Buffer.byteLength(JSON.stringify(options.argv)) > 32 * 1024) throw new Error('Invalid frozen execution limits or command');
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 1024 * 1024) throw new Error('Invalid frozen output limit');
  if (options.control !== undefined && (Object.keys(options.control).length !== 2
    || !['cancellation', 'timeout'].includes(options.control.kind) || !Number.isSafeInteger(options.control.afterMs)
    || options.control.afterMs < 1 || options.control.afterMs >= options.timeoutMs)) throw new Error('Invalid frozen control experiment');
  if (options.control && typeof provider.frozen.killFrozenContainer !== 'function') throw new Error('Frozen control is not supported by provider');
  if (options.scratch) {
    validateScratch(options);
    const recovery = options.scratch.recovery;
    if (recovery) {
      const pin = (assertions: readonly FrozenScratchAssertion[]) => Object.freeze(assertions.map(record => Object.freeze({ ...record })));
      options = { ...options, scratch: Object.freeze({ ...options.scratch, recovery: Object.freeze({ ...recovery,
        assertions: Object.freeze({ fault: pin(recovery.assertions.fault), recovered: pin(recovery.assertions.recovered), replayed: pin(recovery.assertions.replayed) }),
        ...(recovery.returnAssertions === undefined ? {} : { returnAssertions: Object.freeze({
          fault: Object.freeze({ ...recovery.returnAssertions.fault }), recovery: Object.freeze({ ...recovery.returnAssertions.recovery }),
          replay: Object.freeze({ ...recovery.returnAssertions.replay }),
        }) }) }) }) };
    }
  }
  const operationId = randomUUID();
  const context = buildFrozenContext(options.input, options.baseImageId, operationId, options.scratch?.helper);
  const ownership = Object.freeze({ operationId, engine: 'docker' as const, containerName: `afk-frozen-${operationId}`,
    baseImageId: options.baseImageId, inputDigest: options.input.digest, contextDigest: context.digest });
  const engine = provider.frozen;
  const administration: FrozenCommandOptions = { timeoutMs: 30_000, maxOutputBytes: 256 * 1024 };
  const started = performance.now();
  let value: FrozenExecutionResult | undefined;
  let failure: unknown;
  let failed = false;
  let allocationUnconfirmed = false;
  try {
    await registerFrozenOwnership(options, ownership, started);
    checkAbort();
    allocationUnconfirmed = true;
    const imageId = await engine.buildFrozenImage(operationId, options.baseImageId, context.archive, administration);
    allocationUnconfirmed = false;
    checkAbort();
    const argv = frozenExecutionArgv(options, operationId);
    allocationUnconfirmed = true;
    const containerId = await engine.createFrozenContainer(operationId, imageId, argv, administration);
    allocationUnconfirmed = false;
    checkAbort();
    const inspected = await engine.inspectFrozenContainer(containerId, administration);
    assertPolicy(inspected, operationId, containerId, imageId, argv);
    if (inspected.status !== 'created') throw new Error('Frozen container ran before policy verification');
    options.onContainer?.(Object.freeze({ operationId, containerId }));
    checkAbort();
    const controlled = options.control ? await executeControlled(engine, containerId, operationId, options, started,
      inspection => assertPolicy(inspection, operationId, containerId, imageId, argv)) : undefined;
    const result = controlled?.result ?? await engine.startFrozenContainer(containerId, { timeoutMs: options.timeoutMs,
      maxOutputBytes: options.scratch ? 512 * 1024 : maxOutputBytes, signal: options.signal });
    checkAbort();
    const completed = controlled?.completed ?? await engine.inspectFrozenContainer(containerId, administration);
    assertPolicy(completed, operationId, containerId, imageId, argv);
    if (completed.status !== 'exited' || completed.exitCode !== result.code) throw new Error('Frozen execution exit was not confirmed');
    const scratch = options.scratch ? scratchResult(result, options, operationId, containerId) : undefined;
    if (scratch?.evidence.recovery) verifyFrozenScratchRecoveryEvidence(options, scratch.evidence.recovery, operationId, containerId);
    const digest = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const policyInspection = controlled?.control.outcome === 'not-triggered' ? completed : inspected;
    const { status: _status, exitCode: _exitCode, ...policy } = policyInspection;
    value = { exitCode: completed.exitCode, stdout: scratch?.stdout ?? result.stdout, stderr: scratch?.stderr ?? result.stderr,
      evidence: { operationId, containerId, baseImageId: options.baseImageId, imageId, inputDigest: options.input.digest,
        contextDigest: context.digest, commandDigest: digest({ argv: [...inspected.entrypoint, ...inspected.command], cwd: '/workspace' }),
        policyDigest: digest(policy), mechanism: 'docker-frozen-image', argv: [...inspected.entrypoint, ...inspected.command],
        cwd: '/workspace', durationMs: performance.now() - started, policy: policyInspection,
        ...(controlled ? { control: controlled.control } : {}), ...(scratch ? { scratch: scratch.evidence } : {}) }, cleanup: { containerRemoved: true, imageRemoved: true } };
  } catch (error) { failure = error; failed = true; }
  let cleanupFailure: unknown;
  let cleanupFailed = false;
  try {
    await engine.cleanupFrozenOperation(operationId, { ...administration, timeoutMs: 15_000 });
  } catch (error) { cleanupFailure = error; cleanupFailed = true; }
  if (cleanupFailed || allocationUnconfirmed) {
    const hasCause = failed || options.signal?.aborted === true;
    const cause = failed ? failure : options.signal?.aborted ? options.signal.reason : undefined;
    const errors = hasCause ? [cause] : [];
    if (cleanupFailed) errors.push(cleanupFailure);
    if (allocationUnconfirmed) errors.push(new Error('Frozen allocation completion is unconfirmed despite current cleanup inventory'));
    throw new FrozenCleanupError(ownership, errors, cause);
  }
  if (failed) throw failure;
  checkAbort();
  if (!value) throw new Error('Frozen execution produced no result');
  return value;
}
