import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { frozenExecutionArgv, verifyFrozenScratchRecoveryOutcome, type FrozenExecutionOptions,
  type FrozenExecutionResult } from '../../infrastructure/sandbox/container/frozen-execution.js';
import { buildFrozenContext } from '../../infrastructure/sandbox/container/frozen-input.js';
import type { FrozenScratchBaselineFailure } from '../../infrastructure/sandbox/container/types.js';
import { DISTILLATION_LIMITS } from './contracts.js';
import { canonicalLearningJson, learningIdentitySchema } from './requests.js';
import type { PreparedAssetProposal, ProposalCheck } from './proposals.js';
import { checkProposalToolParameterPaths, compileProposalToolSchema, type ProposalToolSchema } from './proposal-tool-schema.js';

export function compareProposalActual(actual: unknown, expected: unknown): boolean {
  const encode = (value: unknown): string => {
    let entries = 0;
    const inspect = (entry: unknown, depth: number): void => {
      if (++entries > 4096 || depth > 32) throw new Error('Proposal oracle actual exceeds structure limit');
      if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return;
      if (typeof entry === 'number' && Number.isFinite(entry)) return;
      if (Array.isArray(entry)) { for (const item of entry) inspect(item, depth + 1); return; }
      if (typeof entry !== 'object' || Object.getPrototypeOf(entry) !== Object.prototype) throw new Error('Proposal oracle requires JSON actual and expected');
      for (const item of Object.values(entry)) inspect(item, depth + 1);
    };
    inspect(value, 0);
    const encoded = canonicalLearningJson(value);
    if (Buffer.byteLength(encoded) > DISTILLATION_LIMITS.outputBytes) throw new Error('Proposal oracle actual exceeds byte limit');
    return encoded;
  };
  return encode(actual) === encode(expected);
}

const assertionSchema = z.object({
  id: learningIdentitySchema,
  source: z.enum(['stdout-json', 'stderr-json', 'stdout', 'stderr', 'exit-code', 'control']),
  path: z.array(z.string().min(1).max(256).refine(value => !['__proto__', 'prototype', 'constructor'].includes(value))).max(16).optional(),
  expected: z.unknown().refine(value => value !== undefined),
}).strict();
const recoveryResourceSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,31}$/),
  path: z.string().min(1).max(64).refine(value => value.split('/').every(segment => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(segment))),
}).strict();
const recoveryStateSchema = recoveryResourceSchema.extend({ bytes: z.string().max(4 * Math.ceil(16 * 1024 / 3))
  .refine(value => value.length <= 4 * Math.ceil(16 * 1024 / 3) && Buffer.from(value, 'base64').length <= 16 * 1024
    && Buffer.from(value, 'base64').toString('base64') === value).nullable() }).strict();
const recoveryOutputSchema = z.string().max(DISTILLATION_LIMITS.outputBytes * 2).regex(/^(?:[a-f0-9]{2})*$/);
const recoveryReturnSchema = z.object({ exitCode: z.number().int().safe().min(0).max(255), signal: z.null(),
  stdoutHex: recoveryOutputSchema, stderrHex: recoveryOutputSchema }).strict();
const recoverySchema = z.object({
  contractRevision: z.literal('bounded-recovery-return-state-v1'),
  resources: z.array(recoveryResourceSchema).min(1).max(4),
  callInput: z.string().max(2048).refine(value => !value.includes('\0')),
  requireEffectHistory: z.boolean(),
  assertions: z.object({ fault: z.array(recoveryStateSchema).min(1).max(4),
    recovered: z.array(recoveryStateSchema).min(1).max(4), replayed: z.array(recoveryStateSchema).min(1).max(4) }).strict(),
  returnAssertions: z.object({ fault: recoveryReturnSchema.extend({ exitCode: z.number().int().safe().min(1).max(255) }),
    recovery: recoveryReturnSchema.extend({ exitCode: z.literal(0) }), replay: recoveryReturnSchema.extend({ exitCode: z.literal(0) }) }).strict(),
}).strict().superRefine((value, context) => {
  const reject = () => context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid bounded recovery contract' });
  if (new Set(value.resources.map(resource => resource.id)).size !== value.resources.length
    || new Set(value.resources.map(resource => resource.path)).size !== value.resources.length) reject();
  for (const states of Object.values(value.assertions)) {
    if (states.length !== value.resources.length || states.some((state, index) => state.id !== value.resources[index]?.id
      || state.path !== value.resources[index]?.path)) reject();
  }
  if (!value.assertions.fault.some(state => state.bytes !== null)
    || !value.assertions.fault.some((state, index) => state.bytes !== value.assertions.recovered[index]?.bytes)
    || value.assertions.recovered.some((state, index) => state.bytes !== value.assertions.replayed[index]?.bytes)) reject();
  if (Object.values(value.returnAssertions).reduce((total, returned) => total + (returned.stdoutHex.length + returned.stderrHex.length) / 2, 0)
    > DISTILLATION_LIMITS.outputBytes) reject();
});
const experimentSchema = z.object({
  protocol: z.literal('proposal-semantic-v1'), adapter: z.literal('node-json-argv-v1'),
  kind: z.enum(['normal', 'refusal', 'recovery', 'cancellation', 'timeout', 'permission-denied']),
  input: z.string().max(2048), callInput: z.string().max(2048).refine(value => !value.includes('\0')).optional(),
  assertions: z.array(assertionSchema).min(2).max(32),
  control: z.object({ kind: z.enum(['cancellation', 'timeout']), afterMs: z.number().int().positive().max(120_000) }).strict().optional(),
  recovery: recoverySchema.optional(),
}).strict();
export const proposalSemanticConfigurationSchema = experimentSchema;
export type ProposalSemanticConfiguration = z.infer<typeof experimentSchema>;
export type PreparedProposalExperiment = ProposalSemanticConfiguration & {
  checkId: string; checkDigest: string; artifactPath: string; argv: string[];
};
export interface ProposalSemanticExecutionContext {
  readonly options: FrozenExecutionOptions;
  readonly operationId: string;
  readonly containerId: string;
}
export interface ProposalSemanticObservation {
  protocol: 'proposal-semantic-v1'; experimentDigest: string; deliveredInputDigest: string;
  baselineFailure?: { phase: FrozenScratchBaselineFailure['failedPhase']; reason: FrozenScratchBaselineFailure['reason'];
    expectedExitCode: number; observedExitCode: number; phasesObserved: number; evidenceDigest: string };
  assertions: { id: string; source: ProposalSemanticConfiguration['assertions'][number]['source']; path?: string[];
    expected: unknown; actual?: unknown; status: 'observed' | 'unknown'; passed: boolean }[];
  passed: boolean;
}
const digest = (value: unknown) => createHash('sha256').update(canonicalLearningJson(value)).digest('hex');

export function prepareProposalExperiment(kind: PreparedAssetProposal['kind'], artifactPath: string, check: ProposalCheck, input: unknown,
  toolInputSchema?: ProposalToolSchema):
  { status: 'prepared'; experiment: PreparedProposalExperiment } | { status: 'unsupported'; reason: string } {
  const configured = experimentSchema.parse(input);
  const { recovery, ...direct } = configured;
  compareProposalActual(direct, direct);
  if (configured.kind !== check.kind || configured.input !== check.input) throw new Error('Semantic experiment differs from proposal check');
  if (!artifactPath || artifactPath.startsWith('/') || artifactPath.includes('\\') || artifactPath.includes('\0')
    || artifactPath.split('/').some(part => !part || ['.', '..', '.git'].includes(part))) throw new Error('Invalid semantic artifact path');
  if (new Set(configured.assertions.map(entry => entry.id)).size !== configured.assertions.length) throw new Error('Duplicate semantic assertion');
  for (const assertion of configured.assertions) {
    compareProposalActual(assertion.expected, assertion.expected);
    if (!assertion.source.endsWith('-json') && assertion.source !== 'control' && assertion.path !== undefined) throw new Error('Semantic assertion path requires JSON output');
    if (assertion.source === 'exit-code' && (!Number.isSafeInteger(assertion.expected) || Number(assertion.expected) < 0 || Number(assertion.expected) > 255)) {
      throw new Error('Invalid expected semantic exit code');
    }
  }
  if (recovery !== undefined && check.kind !== 'recovery') throw new Error('Semantic recovery differs from check kind');
  if (kind !== 'tool') return { status: 'unsupported', reason: 'skill_interpreter_unavailable' };
  if (!['normal', 'refusal', 'recovery', 'cancellation', 'timeout'].includes(check.kind)) return { status: 'unsupported', reason: 'control_experiment_unavailable' };
  const recovering = check.kind === 'recovery';
  if (recovering && recovery === undefined) return { status: 'unsupported', reason: 'recovery_contract_unavailable' };
  const controlled = check.kind === 'cancellation' || check.kind === 'timeout';
  if (!controlled && !recovering && configured.callInput !== undefined) throw new Error('Semantic call input cannot replace a normal or refusal case');
  if (controlled ? configured.control?.kind !== check.kind : configured.control !== undefined || configured.assertions.some(entry => entry.source === 'control')) {
    throw new Error('Semantic control differs from check kind');
  }
  const exits = configured.assertions.filter(entry => entry.source === 'exit-code');
  if (exits.length !== 1 || !configured.assertions.some(entry => entry.source !== 'exit-code')
    || (controlled ? exits[0].expected !== 137 : check.kind === 'normal' || recovering ? exits[0].expected !== 0 : exits[0].expected === 0)) throw new Error('Semantic experiment lacks required outcome assertions');
  if (check.kind === 'normal') {
    const parsedInput: unknown = JSON.parse(configured.input);
    compareProposalActual(parsedInput, parsedInput);
  }
  if (controlled) {
    if (configured.callInput === undefined || toolInputSchema === undefined) return { status: 'unsupported', reason: 'control_input_unavailable' };
    const callInput: unknown = JSON.parse(configured.callInput);
    compareProposalActual(callInput, callInput);
    checkProposalToolParameterPaths(callInput);
    if (!compileProposalToolSchema(toolInputSchema)(callInput)) throw new Error('Semantic call input does not satisfy tool input schema');
  }
  if (recovery !== undefined) {
    if (configured.callInput === undefined || toolInputSchema === undefined) return { status: 'unsupported', reason: 'recovery_input_unavailable' };
    if (configured.callInput === recovery.callInput) throw new Error('Semantic recovery requires distinct business inputs');
    const validateInput = compileProposalToolSchema(toolInputSchema);
    for (const encoded of [configured.callInput, recovery.callInput]) {
      const callInput: unknown = JSON.parse(encoded);
      compareProposalActual(callInput, callInput);
      checkProposalToolParameterPaths(callInput);
      if (!validateInput(callInput)) throw new Error('Semantic call input does not satisfy tool input schema');
    }
    if (recovery.requireEffectHistory) return { status: 'unsupported', reason: 'recovery_effect_history_unsupported' };
  }
  const experiment: PreparedProposalExperiment = JSON.parse(canonicalLearningJson({ ...configured, checkId: check.id,
    checkDigest: digest(check), artifactPath, argv: ['node', recovering ? artifactPath : `/workspace/${artifactPath}`, configured.callInput ?? configured.input] }));
  return { status: 'prepared', experiment };
}

export function observeProposalExperiment(experiment: PreparedProposalExperiment, execution: Readonly<FrozenExecutionResult>,
  context?: ProposalSemanticExecutionContext): ProposalSemanticObservation {
  let baselineFailure: ProposalSemanticObservation['baselineFailure'];
  if (experiment.recovery !== undefined) {
    if (!context?.options.scratch?.recovery) throw new Error('Semantic recovery requires trusted execution context');
    const { options, operationId, containerId } = context;
    const scratch = options.scratch!;
    const { contractRevision: _contractRevision, resources, ...recovery } = experiment.recovery;
    if (options.control !== undefined || !isDeepStrictEqual(options.argv, experiment.argv)
      || scratch.artifactPath !== experiment.artifactPath || scratch.callInput !== experiment.callInput
      || !isDeepStrictEqual(scratch.resources, resources) || !isDeepStrictEqual(scratch.recovery, recovery)
      || execution.evidence.operationId !== operationId || execution.evidence.containerId !== containerId
      || execution.evidence.inputDigest !== options.input.digest || execution.evidence.baseImageId !== options.baseImageId
      || execution.evidence.contextDigest !== buildFrozenContext(options.input, options.baseImageId, operationId, scratch.helper).digest
      || execution.evidence.mechanism !== 'docker-frozen-image' || execution.evidence.cwd !== '/workspace'
      || execution.exitCode !== 0) throw new Error('Semantic recovery differs from trusted execution context');
    const observation = execution.evidence.scratch;
    const verified = verifyFrozenScratchRecoveryOutcome(options, observation?.baselineFailure ?? observation?.recovery, operationId, containerId);
    if ('failedPhase' in verified) {
      const phase = verified.phases.find(entry => entry.phase === verified.failedPhase)!;
      baselineFailure = { phase: phase.phase, reason: verified.reason, expectedExitCode: recovery.returnAssertions[phase.phase].exitCode,
        observedExitCode: phase.invocation.exitCode!, phasesObserved: verified.phases.length, evidenceDigest: digest(verified) };
    } else if (verified.contractRevision !== experiment.recovery.contractRevision || verified.qualification !== 'qualified-bounded-returns-and-state') {
      throw new Error('Semantic recovery qualification differs from saved returns');
    }
    if (execution.stdout !== verified.phases.map(phase => Buffer.from(phase.stdoutHex, 'hex').toString('utf8')).join('')
      || execution.stderr !== verified.phases.map(phase => Buffer.from(phase.stderrHex, 'hex').toString('utf8')).join('')) {
      throw new Error('Semantic recovery output or qualification differs from saved returns');
    }
    const { phase: _phase, ordinal: _ordinal, invocationId: _invocationId, stdoutHex: _stdoutHex, stderrHex: _stderrHex,
      ...firstEvidence } = verified.phases[0]!;
    if (!isDeepStrictEqual(observation, { ...firstEvidence, [baselineFailure ? 'baselineFailure' : 'recovery']: verified })) {
      throw new Error('Semantic recovery outer evidence differs from verified phases');
    }
  }
  const argv = ['/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/scratch', 'TMPDIR=/scratch',
    ...(experiment.recovery ? frozenExecutionArgv(context!.options, context!.operationId) : experiment.argv)];
  if (canonicalLearningJson(execution.evidence.argv) !== canonicalLearningJson(argv)
    || experiment.argv[2] !== (experiment.callInput ?? experiment.input) || !execution.cleanup.containerRemoved || !execution.cleanup.imageRemoved) {
    throw new Error('Semantic input delivery or cleanup differs from experiment');
  }
  const control = execution.evidence.control;
  let controlTriggered = experiment.control === undefined;
  if (experiment.control !== undefined) {
    if (!control || control.kind !== experiment.control.kind || control.afterMs !== experiment.control.afterMs
      || control.operationId !== execution.evidence.operationId || control.containerId !== execution.evidence.containerId
      || !Number.isSafeInteger(control.exitCode) || control.exitCode < 0 || control.exitCode !== execution.exitCode
      || !Number.isFinite(control.terminatedMs) || control.terminatedMs < 0) {
      throw new Error('Semantic control was not independently observed');
    }
    if (control.outcome === 'triggered') {
      if (control.trigger !== (control.kind === 'timeout' ? 'host-deadline' : 'host-cancellation') || control.signal !== 'SIGKILL'
        || control.exitCode !== 137 || ![control.runningObservedMs, control.triggeredMs].every(value => Number.isFinite(value) && value >= 0)
        || control.triggeredMs < control.runningObservedMs + control.afterMs || control.terminatedMs < control.triggeredMs) {
        throw new Error('Semantic control trigger was not independently observed');
      }
      controlTriggered = true;
    } else if (control.outcome === 'not-triggered') {
      const policy = execution.evidence.policy;
      if (control.reason !== 'early-exit' || control.trigger !== null || control.signal !== null || control.triggeredMs !== null
        || (control.runningObservedMs !== null && (!Number.isFinite(control.runningObservedMs)
          || control.runningObservedMs < 0 || control.runningObservedMs > control.terminatedMs))
        || !policy || policy.status !== 'exited' || policy.exitCode !== execution.exitCode || policy.id !== control.containerId
        || policy.operationId !== control.operationId || policy.imageId !== execution.evidence.imageId) {
        throw new Error('Semantic control early exit was not independently observed');
      }
    } else throw new Error('Semantic control outcome was not independently observed');
  } else if (control !== undefined) throw new Error('Unexpected semantic control execution');
  const assertions: ProposalSemanticObservation['assertions'] = experiment.assertions.map(assertion => {
    const observation: ProposalSemanticObservation['assertions'][number] = { ...assertion, status: 'unknown', passed: false };
    let actual: unknown;
    try {
      if (assertion.source === 'exit-code') actual = execution.exitCode;
      else if (assertion.source === 'control') actual = control;
      else {
        const output = assertion.source.startsWith('stdout') ? execution.stdout : execution.stderr;
        if (Buffer.byteLength(output) > DISTILLATION_LIMITS.outputBytes) return observation;
        actual = assertion.source.endsWith('-json') ? JSON.parse(output) : output;
      }
      for (const segment of assertion.path ?? []) {
        if (Array.isArray(actual) && (!/^(0|[1-9][0-9]*)$/.test(segment) || !Number.isSafeInteger(Number(segment)) || Number(segment) >= actual.length)) return observation;
        if (actual === null || typeof actual !== 'object' || !Object.hasOwn(actual, segment)) return observation;
        actual = (actual as { [key: string]: unknown })[segment];
      }
      observation.passed = compareProposalActual(actual, assertion.expected);
      observation.actual = JSON.parse(canonicalLearningJson(actual));
      observation.status = 'observed';
    } catch { return observation; }
    return observation;
  });
  return { protocol: 'proposal-semantic-v1', experimentDigest: digest(experiment),
    deliveredInputDigest: createHash('sha256').update(experiment.callInput ?? experiment.input).digest('hex'), assertions,
    ...(baselineFailure ? { baselineFailure } : {}),
    passed: !baselineFailure && controlTriggered && assertions.every(assertion => assertion.status === 'observed' && assertion.passed) };
}
