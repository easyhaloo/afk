/**
 * Structured failure diagnostics.
 *
 * A failure used to be one mutable string that every later failure
 * overwrote, and the string mixed the agent's own report with the provider's
 * captured output. Both are gone here.
 *
 * A {@link FailureDiagnostic} keeps four things apart:
 *
 * - `code` — the stable identity of the failure, so a tool can branch on it.
 * - `class` — what the failure is *about*: the work, the agent run, an
 *   external dependency, the machine, or AFK's own plumbing.
 * - `message` — one human-readable root cause, never provider noise.
 * - `evidence` — the facts behind it: probes, commands, exit codes, the
 *   truncated tail of the agent's output.
 *
 * The first failure wins. Later failures are appended to the chain instead of
 * replacing it, so the root cause of a run survives every piece of secondary
 * information that arrives after it.
 */

import type { RunFailureReasonCode } from '@afk/core';
import { classifyAgentFailure } from '../../domain/agents/failure.js';
import type { ExecutionResult } from '../../domain/agents/types.js';
import { parseAcVerificationFailure } from './execution-protocol.js';

/**
 * What a failure is about.
 *
 * The three kinds the operator must be able to tell apart at a glance:
 * a verdict on the work, a fact about the agent run, and a fact about an
 * external dependency.
 */
export type FailureClass =
  /** A verdict about the work: the agent reported it could not do it. */
  | 'work'
  /** A fact about how the agent run went: silent, gone, no result. */
  | 'agent'
  /** A fact about an external dependency: the model service, the transport. */
  | 'upstream'
  /** A fact about the machine the work runs on. */
  | 'environment'
  /** A fact about AFK's own execution plumbing. */
  | 'infrastructure';

/** What kind of evidence an entry carries. */
export type FailureEvidenceKind =
  /** An environment probe: what was probed, what was expected, what was seen. */
  | 'probe'
  /** A command that was run, with its exit code. */
  | 'command'
  /** Raw output, truncated to a size limit. */
  | 'output'
  /** Facts about a time budget that ran out. */
  | 'timeout'
  /** When the agent last did something. */
  | 'activity'
  /** The provider's structured output. */
  | 'structured'
  /** Anything else worth recording. */
  | 'context';

/** One piece of structured evidence behind a failure. */
export interface FailureEvidence {
  kind: FailureEvidenceKind;
  /** A short human label, e.g. `agent output (last 40 lines)`. */
  label: string;
  /** What was expected, when the evidence compares against a requirement. */
  expected?: string;
  /** What was actually seen. */
  actual?: string;
  /** The command that produced the evidence. */
  command?: string;
  /** The exit code of that command. */
  exitCode?: number;
  /** The evidence itself, truncated when it is long. */
  detail?: string;
  /** True when `detail` was cut to fit the size limit. */
  truncated?: boolean;
}

/** A structured failure diagnosis. */
export interface FailureDiagnostic {
  /** The stable, machine-readable failure code. */
  code: RunFailureReasonCode;
  /** The coarse category the failure belongs to. */
  class: FailureClass;
  /** One human-readable root cause. Never provider noise. */
  message: string;
  /** The provider's own error code, preserved verbatim (`AGENT_IDLE`, …). */
  providerCode?: string;
  /** The failure that came before this one. */
  cause?: FailureDiagnostic;
  /** The facts behind the failure. */
  evidence: FailureEvidence[];
  /** True when repeating the attempt is meaningful. */
  retryable: boolean;
  /** When the failure was classified. */
  at: string;
}

/** Every failure code this model can produce. */
export const FAILURE_CODES = [
  'work_reported_failure',
  'acceptance_criteria_failed',
  'budget_exhausted',
  'handoff_budget_exhausted',
  'agent_completion_timeout',
  'agent_hard_timeout',
  'agent_idle_timeout',
  'agent_session_ended',
  'agent_signal_mismatch',
  'agent_missing_result',
  'agent_process_failed',
  'agent_spawn_failed',
  'agent_interrupted',
  'agent_execution_failed',
  'agent_turn_failed',
  'upstream_model_error',
  'upstream_transport_closed',
  'upstream_transport_close_failed',
  'qa_environment_missing',
  'workflow_setup',
  'workflow_crash',
  'repository_publication',
  'provider_change_unconfirmed',
  'qa_rework',
  'merge_conflict',
] as const satisfies readonly RunFailureReasonCode[];

/** How many bytes of provider output are kept as evidence. */
export const FAILURE_OUTPUT_LIMIT_BYTES = 4096;

/** How many output lines are kept as evidence. */
export const FAILURE_OUTPUT_LIMIT_LINES = 40;

/** How deep the cause chain is preserved inside an audit event. */
export const FAILURE_CAUSE_DEPTH_LIMIT = 8;

/**
 * The coarse class of each failure code.
 *
 * The mapping is the contract: a consumer that only reads `class` can tell a
 * broken build from a silent agent from somebody else's outage.
 */
const FAILURE_CLASSES: Readonly<Record<RunFailureReasonCode, FailureClass>> = {
  // A verdict about the work.
  work_reported_failure: 'work',
  acceptance_criteria_failed: 'work',
  budget_exhausted: 'work',
  handoff_budget_exhausted: 'work',
  agent_completion_timeout: 'work',
  agent_hard_timeout: 'work',
  qa_rework: 'work',
  qa_timeout: 'work',
  qa_execution_failed: 'work',
  // A fact about the agent run.
  agent_idle_timeout: 'agent',
  agent_session_ended: 'agent',
  agent_signal_mismatch: 'agent',
  agent_missing_result: 'agent',
  agent_process_failed: 'agent',
  agent_spawn_failed: 'agent',
  agent_interrupted: 'agent',
  agent_execution_failed: 'agent',
  // A fact about an external dependency.
  agent_turn_failed: 'upstream',
  upstream_model_error: 'upstream',
  upstream_transport_closed: 'upstream',
  upstream_transport_close_failed: 'upstream',
  // A fact about the machine.
  qa_environment_missing: 'environment',
  // A fact about AFK's own plumbing.
  workflow_setup: 'infrastructure',
  workflow_crash: 'infrastructure',
  repository_publication: 'infrastructure',
  provider_change_unconfirmed: 'infrastructure',
  merge_conflict: 'infrastructure',
};

/** The coarse class a failure code belongs to. */
export function failureClassOf(code: RunFailureReasonCode): FailureClass {
  return FAILURE_CLASSES[code];
}

/** Build a structured failure diagnosis. */
export function createFailureDiagnostic(input: {
  code: RunFailureReasonCode;
  message: string;
  providerCode?: string;
  evidence?: FailureEvidence[];
  retryable?: boolean;
  cause?: FailureDiagnostic;
  at?: string;
}): FailureDiagnostic {
  return {
    code: input.code,
    class: failureClassOf(input.code),
    message: input.message,
    ...(input.providerCode === undefined ? {} : { providerCode: input.providerCode }),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
    evidence: input.evidence ?? [],
    retryable: input.retryable ?? false,
    at: input.at ?? new Date().toISOString(),
  };
}

/**
 * Append a failure to the chain.
 *
 * The first failure is the root cause and is never replaced. A later failure
 * becomes the next link: it points back at the one before it, so the root
 * stays reachable from the newest failure.
 */
export function appendFailure(
  chain: readonly FailureDiagnostic[],
  diagnostic: FailureDiagnostic,
): FailureDiagnostic[] {
  const previous = chain.at(-1);
  const linked = previous === undefined ? diagnostic : { ...diagnostic, cause: previous };
  return [...chain, linked];
}

/** The root cause of a chain: the first failure that was recorded. */
export function rootCause(chain: readonly FailureDiagnostic[]): FailureDiagnostic | undefined {
  return chain[0];
}

/** The failures that came after the root cause. */
export function aftermath(chain: readonly FailureDiagnostic[]): FailureDiagnostic[] {
  return chain.slice(1);
}

/**
 * The one-line summary of a chain: the root cause, and nothing else.
 *
 * This is what the audit trail and the backlog item carry, so it must stay
 * short and must not be a pile of provider output.
 */
export function renderFailureSummary(chain: readonly FailureDiagnostic[]): string | undefined {
  return rootCause(chain)?.message;
}

/**
 * The full report of a chain: the root cause, what came after it, and the
 * evidence behind each.
 */
export function renderFailureReport(chain: readonly FailureDiagnostic[]): string {
  const root = rootCause(chain);
  if (!root) return 'no failure recorded';
  const lines = [root.message];
  const later = aftermath(chain);
  if (later.length > 0) {
    lines.push('Aftermath:');
    for (const failure of later) lines.push(`  - ${failure.code}: ${failure.message}`);
  }
  for (const failure of chain) {
    if (failure.evidence.length === 0) continue;
    lines.push(`Evidence (${failure.code}):`);
    for (const evidence of failure.evidence) {
      lines.push(`  - ${evidence.label}${evidence.detail ? `: ${evidence.detail}` : ''}`);
    }
  }
  return lines.join('\n');
}

/** A plain snapshot of a failure, for the audit trail. */
export interface FailureSnapshot {
  code: string;
  class: string;
  message: string;
  at?: string;
  cause?: FailureSnapshot;
}

/**
 * Snapshot a failure and its cause chain for an audit event.
 *
 * The chain is copied by value and cut at a fixed depth, so an event stays a
 * bounded size while the first failure remains readable in the stream.
 */
export function snapshotFailure(
  failure: FailureDiagnostic | undefined,
  depth = FAILURE_CAUSE_DEPTH_LIMIT,
): FailureSnapshot | undefined {
  if (!failure) return undefined;
  const snapshot: FailureSnapshot = {
    code: failure.code,
    class: failure.class,
    message: failure.message,
    ...(failure.at ? { at: failure.at } : {}),
  };
  if (depth > 0 && failure.cause) {
    const cause = snapshotFailure(failure.cause, depth - 1);
    if (cause) snapshot.cause = cause;
  }
  return snapshot;
}

/**
 * Keep the tail of a long output.
 *
 * The tail is what the process said last, which is where a failure usually
 * shows up. The head is dropped on purpose: it is the part that scrolls away
 * while the failure is still being written.
 */
export function truncateOutputTail(
  output: string,
  limitBytes = FAILURE_OUTPUT_LIMIT_BYTES,
  limitLines = FAILURE_OUTPUT_LIMIT_LINES,
): { detail: string; truncated: boolean } {
  const lines = output.split('\n');
  const tail = lines.slice(-limitLines).join('\n');
  const limited = tail.length > limitBytes ? tail.slice(-limitBytes) : tail;
  return { detail: limited, truncated: tail.length > limitBytes || lines.length > limitLines };
}

/**
 * The lines of provider output that look like an error.
 *
 * A pre-commit hook's rejection is buried in a `pnpm` log, and the tail of
 * that log is what used to replace it. Pulling the error lines out keeps the
 * actual reason reachable.
 */
export function extractFailureLines(output: string, limit = 20): string[] {
  const pattern = /(^|\s)(error|err!|✖|failed|failure|fatal|rejected|cannot find|not found|TS\d{4}|ESLint|Prettier hook failed|husky)/i;
  const found: string[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (!line || line.length > 500) continue;
    if (!pattern.test(line)) continue;
    if (found.includes(line)) continue;
    found.push(line);
    if (found.length >= limit) break;
  }
  return found;
}

/**
 * The reason the agent itself reported, when it reported one.
 *
 * The agent's own summary is the closest thing to a verdict about the work,
 * so it wins over anything the provider inferred.
 */
export function agentReportedReason(result: ExecutionResult): string | undefined {
  const output = result.structuredOutput;
  if (!output || typeof output !== 'object') return undefined;
  const summary = (output as { summary?: unknown }).summary;
  return typeof summary === 'string' && summary.trim().length > 0 ? summary.trim() : undefined;
}

/**
 * Diagnose a step that did not complete.
 *
 * A step fails in one of two ways: the agent reported that it could not do
 * the work, or the acceptance criteria did not hold. The second is a verdict
 * with evidence — every criterion that failed, with what was expected and
 * what was actually seen.
 */
export function diagnoseStepFailure(step: {
  stepId: string;
  status: string;
  summary?: string;
  output?: unknown;
}): FailureDiagnostic {
  const acFailure = parseAcVerificationFailure(step.output);
  if (acFailure) {
    return createFailureDiagnostic({
      code: 'acceptance_criteria_failed',
      message: acFailure.summary,
      evidence: [
        { kind: 'context', label: `acceptance criteria failed in step '${step.stepId}'`, actual: acFailure.summary },
        ...acFailure.failedCriteria.map(criterion => ({
          kind: 'context' as const,
          label: `criterion ${criterion.id}`,
          expected: criterion.expected,
          actual: criterion.actual,
        })),
      ],
    });
  }
  return createFailureDiagnostic({
    code: 'work_reported_failure',
    message: step.summary ?? `step '${step.stepId}' did not complete (${step.status})`,
    evidence: [{ kind: 'context', label: `step '${step.stepId}' status`, actual: step.status }],
  });
}

/** The provider error code mapped onto the failure vocabulary. */
const PROVIDER_CODE_FAILURES: Readonly<Record<string, RunFailureReasonCode>> = {
  AGENT_ERROR: 'upstream_model_error',
  AGENT_TURN_FAILED: 'agent_turn_failed',
  TRANSPORT_CLOSED: 'upstream_transport_closed',
  TRANSPORT_CLOSE_FAILED: 'upstream_transport_close_failed',
  AGENT_GONE: 'agent_session_ended',
  AGENT_IDLE: 'agent_idle_timeout',
  SIGNAL_MISMATCH: 'agent_signal_mismatch',
  MISSING_RESULT: 'agent_missing_result',
  SPAWN_ERROR: 'agent_spawn_failed',
  NON_ZERO_EXIT: 'agent_process_failed',
};

/** The evidence a timeout carries: the budget, and what the agent last did. */
function timeoutEvidence(result: ExecutionResult): FailureEvidence[] {
  const timeout = result.diagnostics?.timeout;
  if (!timeout) return [];
  const evidence: FailureEvidence[] = [{
    kind: 'timeout',
    label: 'timeout budget',
    expected: `${timeout.budgetMs}ms`,
    actual: timeout.idleMs === undefined ? undefined : `${timeout.idleMs}ms without output`,
  }];
  if (timeout.lastActivityAt) {
    evidence.push({ kind: 'activity', label: 'last known activity', actual: timeout.lastActivityAt });
  }
  return evidence;
}

/**
 * Diagnose a failed agent execution.
 *
 * The agent's own report is the cause when there is one. The provider's
 * captured output is never the cause: it is evidence, and the error lines
 * inside it are lifted into the message so the real reason stays readable.
 */
export function diagnoseExecutionFailure(result: ExecutionResult): FailureDiagnostic {
  const classification = classifyAgentFailure(result);
  const providerCode = result.error?.code;
  const reported = agentReportedReason(result);
  const output = classification.messageIsProviderOutput ? result.error?.message ?? '' : '';
  const failureLines = output ? extractFailureLines(output) : [];
  const evidence: FailureEvidence[] = [];

  if (output) {
    const tail = truncateOutputTail(output);
    evidence.push({
      kind: 'output',
      label: `agent output (last ${FAILURE_OUTPUT_LIMIT_LINES} lines)`,
      detail: tail.detail,
      truncated: tail.truncated,
    });
    if (failureLines.length > 0) {
      evidence.push({
        kind: 'output',
        label: 'agent reported errors',
        detail: failureLines.join('\n'),
      });
    }
  }

  if (result.structuredOutput !== undefined) {
    evidence.push({
      kind: 'structured',
      label: 'provider structured output',
      detail: safeJson(result.structuredOutput),
    });
  }

  if (result.exitCode !== undefined) {
    evidence.push({ kind: 'command', label: 'agent process exit code', actual: String(result.exitCode) });
  }

  const code = classifyExecutionFailure(result);
  const message = failureMessage(result, code, { reported, failureLines, providerCode });
  return createFailureDiagnostic({
    code,
    message,
    ...(providerCode === undefined ? {} : { providerCode }),
    evidence: [...timeoutEvidence(result), ...evidence],
    retryable: classification.retryable,
  });
}

/** The failure code a failed execution maps to. */
export function classifyExecutionFailure(result: ExecutionResult): RunFailureReasonCode {
  if (result.status === 'aborted') return 'agent_interrupted';
  if (result.status === 'timed_out') {
    if (result.error?.code === 'AGENT_IDLE') return 'agent_idle_timeout';
    if (result.diagnostics?.timeout?.kind === 'hard') return 'agent_hard_timeout';
    return 'agent_completion_timeout';
  }
  const providerCode = result.error?.code;
  if (providerCode) return PROVIDER_CODE_FAILURES[providerCode] ?? 'agent_execution_failed';
  return 'agent_execution_failed';
}

/** The one-line root cause of a failed execution. */
function failureMessage(
  result: ExecutionResult,
  code: RunFailureReasonCode,
  context: { reported?: string; failureLines: string[]; providerCode?: string },
): string {
  if (context.reported) return context.reported;

  const timeout = result.diagnostics?.timeout;
  if (code === 'agent_idle_timeout') {
    const budget = timeout ? `${timeout.budgetMs}ms` : 'the allowed window';
    const silent = timeout?.idleMs === undefined ? '' : ` (silent for ${timeout.idleMs}ms)`;
    return `the agent produced no output for ${silent || `more than ${budget}`} — the idle timeout budget of ${budget} ran out`;
  }
  if (code === 'agent_completion_timeout' || code === 'agent_hard_timeout') {
    const budget = timeout ? `${timeout.budgetMs}ms` : 'its budget';
    const what = code === 'agent_hard_timeout' ? 'the hard timeout killed the agent session' : 'the agent was still running';
    return `the agent did not finish within ${budget} — ${what}`;
  }

  if (code === 'agent_process_failed') {
    const exit = result.exitCode === undefined ? 'a non-zero status' : `exit code ${result.exitCode}`;
    const first = context.failureLines[0];
    return first
      ? `the agent process failed with ${exit}: ${first}`
      : `the agent process failed with ${exit}`;
  }

  const providerMessage = result.error?.message?.trim();
  if (providerMessage) {
    return `${context.providerCode ?? code}: ${collapse(providerMessage)}`;
  }
  return `the agent execution ended with status '${result.status}'`;
}

/** Collapse a multi-line provider message into one readable line. */
function collapse(message: string): string {
  const firstLine = message.split('\n').map(line => line.trim()).find(line => line.length > 0);
  return firstLine ? firstLine.slice(0, 300) : message.slice(0, 300);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserializable]';
  }
}
