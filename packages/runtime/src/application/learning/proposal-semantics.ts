import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FrozenExecutionResult } from '../../infrastructure/sandbox/container/frozen-execution.js';
import { DISTILLATION_LIMITS } from './contracts.js';
import { canonicalLearningJson, learningIdentitySchema } from './requests.js';
import { compareProposalActual, type PreparedAssetProposal, type ProposalCheck } from './proposals.js';

const assertionSchema = z.object({
  id: learningIdentitySchema,
  source: z.enum(['stdout-json', 'stderr-json', 'stdout', 'stderr', 'exit-code', 'control']),
  path: z.array(z.string().min(1).max(256).refine(value => !['__proto__', 'prototype', 'constructor'].includes(value))).max(16).optional(),
  expected: z.unknown().refine(value => value !== undefined),
}).strict();
const experimentSchema = z.object({
  protocol: z.literal('proposal-semantic-v1'), adapter: z.literal('node-json-argv-v1'),
  kind: z.enum(['normal', 'refusal', 'recovery', 'cancellation', 'timeout', 'permission-denied']),
  input: z.string().max(2048), assertions: z.array(assertionSchema).min(2).max(32),
  control: z.object({ kind: z.enum(['cancellation', 'timeout']), afterMs: z.number().int().positive().max(120_000) }).strict().optional(),
}).strict();
export type ProposalSemanticConfiguration = z.infer<typeof experimentSchema>;
export type PreparedProposalExperiment = ProposalSemanticConfiguration & {
  checkId: string; checkDigest: string; artifactPath: string; argv: string[];
};
export interface ProposalSemanticObservation {
  protocol: 'proposal-semantic-v1'; experimentDigest: string; deliveredInputDigest: string;
  assertions: { id: string; source: ProposalSemanticConfiguration['assertions'][number]['source']; path?: string[];
    expected: unknown; actual?: unknown; status: 'observed' | 'unknown'; passed: boolean }[];
  passed: boolean;
}
const digest = (value: unknown) => createHash('sha256').update(canonicalLearningJson(value)).digest('hex');

export function prepareProposalExperiment(kind: PreparedAssetProposal['kind'], artifactPath: string, check: ProposalCheck, input: unknown):
  { status: 'prepared'; experiment: PreparedProposalExperiment } | { status: 'unsupported'; reason: string } {
  compareProposalActual(input, input);
  const configured = experimentSchema.parse(input);
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
  if (kind !== 'tool') return { status: 'unsupported', reason: 'skill_interpreter_unavailable' };
  if (!['normal', 'refusal', 'cancellation', 'timeout'].includes(check.kind)) return { status: 'unsupported', reason: 'control_experiment_unavailable' };
  const controlled = check.kind === 'cancellation' || check.kind === 'timeout';
  if (controlled ? configured.control?.kind !== check.kind : configured.control !== undefined || configured.assertions.some(entry => entry.source === 'control')) {
    throw new Error('Semantic control differs from check kind');
  }
  const exits = configured.assertions.filter(entry => entry.source === 'exit-code');
  if (exits.length !== 1 || !configured.assertions.some(entry => entry.source !== 'exit-code')
    || (controlled ? exits[0].expected !== 137 : check.kind === 'normal' ? exits[0].expected !== 0 : exits[0].expected === 0)) throw new Error('Semantic experiment lacks required outcome assertions');
  if (check.kind === 'normal') {
    const parsedInput: unknown = JSON.parse(configured.input);
    compareProposalActual(parsedInput, parsedInput);
  }
  const experiment: PreparedProposalExperiment = JSON.parse(canonicalLearningJson({ ...configured, checkId: check.id,
    checkDigest: digest(check), artifactPath, argv: ['node', `/workspace/${artifactPath}`, configured.input] }));
  return { status: 'prepared', experiment };
}

export function observeProposalExperiment(experiment: PreparedProposalExperiment, execution: Readonly<FrozenExecutionResult>): ProposalSemanticObservation {
  const argv = ['/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/scratch', 'TMPDIR=/scratch', ...experiment.argv];
  if (canonicalLearningJson(execution.evidence.argv) !== canonicalLearningJson(argv)
    || experiment.argv[2] !== experiment.input || !execution.cleanup.containerRemoved || !execution.cleanup.imageRemoved) {
    throw new Error('Semantic input delivery or cleanup differs from experiment');
  }
  const control = execution.evidence.control;
  if (experiment.control !== undefined) {
    if (!control || control.kind !== experiment.control.kind || control.afterMs !== experiment.control.afterMs
      || control.operationId !== execution.evidence.operationId || control.containerId !== execution.evidence.containerId
      || control.trigger !== (control.kind === 'timeout' ? 'host-deadline' : 'host-cancellation') || control.signal !== 'SIGKILL'
      || control.exitCode !== 137 || execution.exitCode !== 137
      || ![control.runningObservedMs, control.triggeredMs, control.terminatedMs].every(value => Number.isFinite(value) && value >= 0)
      || control.triggeredMs < control.runningObservedMs + control.afterMs || control.terminatedMs < control.triggeredMs) {
      throw new Error('Semantic control was not independently observed');
    }
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
    deliveredInputDigest: createHash('sha256').update(experiment.input).digest('hex'), assertions,
    passed: assertions.every(assertion => assertion.status === 'observed' && assertion.passed) };
}
