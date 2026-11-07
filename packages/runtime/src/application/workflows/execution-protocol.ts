import type { ExecutionMode } from '../../domain/agents/types.js';
export { extractGoalComplete } from '../../shared/goal-complete.js';

type JsonObject = Record<string, string | number | boolean | null | object>;

export type CompletionKind = 'task' | 'qa' | 'ac';

export interface VerificationCriterion { id: string; expected: string; actual: string; }
export interface AcVerificationFailure {
  type: 'goal_complete';
  kind: 'ac_verification';
  result: 'FAIL';
  summary: string;
  failedCriteria: VerificationCriterion[];
}

/**
 * The QA agent never sees the afk-qa skill file: the runtime drives it with
 * the template goal plus the completion protocol. Without this instruction
 * the agent produces binary evidence (screenshots, traces, logs) but never
 * registers it, so the change request publishes without attachments.
 */
const QA_ARTIFACT_INSTRUCTION = 'If this run produced binary evidence (screenshots, traces, logs), write one absolute path per line to .afk/artifacts.txt in the current worktree. The QA runner uploads every listed file and links it from the change request; a run without that file publishes no attachments.';

/**
 * The evidence a QA run publishes is read by a reviewer, not by the runner.
 * One free-text summary cannot separate a passed acceptance criterion from
 * an environment caveat, so the payload carries them in distinct fields.
 */
const QA_EVIDENCE_INSTRUCTION = 'Report the evidence in separated fields: "summary" is one sentence stating the verdict, without repeating the individual test results; "observations" holds one entry per behavioural acceptance criterion, each with the claim and how it was observed; "requiredChecks" holds the commands you re-ran, what each one was expected to show and what it actually showed; "notes" holds environment facts, tooling caveats and anything that is not acceptance evidence.';

/**
 * End-to-end verification instruction for the QA agent.
 *
 * The framework does not decide how E2E is implemented: the project owns its
 * E2E suite, its environment setup and its verification approach. The agent
 * detects whether the project has E2E, provides the environment the way the
 * project expects, runs the project's own E2E verification, and registers the
 * binary evidence (screenshots, logs, traces) through the artifact manifest.
 * When the project has no E2E, or the environment cannot be provided here,
 * the agent records the caveat in "notes" instead of inventing a pass.
 */
const QA_E2E_INSTRUCTION = 'End-to-end verification: detect from the project itself whether it has E2E (for example an e2e test suite, an e2e-setup script, or acceptance criteria that need a live service). If it does, provide the environment the way the project expects — start the backend, frontend and any middleware using the project\'s own scripts — then run the project\'s E2E verification and capture the browser or runtime evidence (screenshots, logs, traces) for the acceptance criteria it covers, registering every file in .afk/artifacts.txt. Use the project\'s own tooling and conventions; do not invent a parallel E2E harness. If the project has no E2E, or its environment cannot be provided on this machine, say so in "notes" and do not claim an E2E pass you did not produce.';

/**
 * The push boundary, stated in the completion protocol.
 *
 * The protocol already said "work only on the current checked-out branch",
 * which forbids switching branches but says nothing about where the commits
 * may be pushed to. An agent told to publish into a PRD baseline branch
 * could satisfy that sentence and still push the baseline forward, because
 * the branch it was told to publish into was named in the same paragraph
 * as the branch it was told to work on.
 *
 * The protocol is the one instruction every agent reads, in both transports
 * and for every phase, so the boundary belongs here as well as in the
 * repository listing: this sentence names no branch, it states the rule.
 */
const PUSH_BOUNDARY_INSTRUCTION = 'Push your commits only to the branch you are working on. The base branch and the target branch of the change request belong to AFK: read them, never push to them. Publishing the change request is AFK\'s job, and AFK stops the run when it finds the target branch moved.';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseFailedCriteria(value: unknown): VerificationCriterion[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const criteria = value.map(entry => {
    if (!entry || typeof entry !== 'object') return undefined;
    const criterion = entry as JsonObject;
    if (!isNonEmptyString(criterion.id) || !isNonEmptyString(criterion.expected) || !isNonEmptyString(criterion.actual)) return undefined;
    return { id: criterion.id, expected: criterion.expected, actual: criterion.actual };
  });
  return criteria.some(entry => entry === undefined) ? undefined : criteria as VerificationCriterion[];
}

export function parseAcVerificationFailure(value: unknown): AcVerificationFailure | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result = value as JsonObject;
  const failedCriteria = parseFailedCriteria(result.failedCriteria);
  if (result.type !== 'goal_complete' || result.kind !== 'ac_verification' || result.result !== 'FAIL' || !isNonEmptyString(result.summary) || !failedCriteria) return undefined;
  return { type: 'goal_complete', kind: 'ac_verification', result: 'FAIL', summary: result.summary, failedCriteria };
}

export function isAcVerificationPass(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const result = value as JsonObject;
  return result.type === 'goal_complete' && result.kind === 'ac_verification' && result.result === 'PASS' && isNonEmptyString(result.summary);
}

/**
 * One labelled piece of a prompt.
 *
 * The label is not decoration: when a prompt turns out to be too long for
 * the provider, the label is what says which piece is responsible.
 */
export interface PromptSegment {
  /** What the piece is, e.g. `goal task statement`. */
  label: string;
  /** The text of the piece. */
  text: string;
}

/**
 * Join prompt segments into the text AFK hands the provider.
 *
 * Segments are separated by a blank line, so the provider reads them as
 * paragraphs rather than as one run-on sentence.
 */
export function assemblePrompt(segments: readonly PromptSegment[], separator = '\n\n'): string {
  return segments
    .map(segment => segment.text)
    .filter(text => text.trim().length > 0)
    .join(separator);
}

/**
 * The batch prompt, as segments.
 *
 * Batch execution receives the same AFK prompt syntax, but must pass the goal
 * as ordinary prompt text: `/goal` is an interactive Claude command, and the
 * batch transport has no command channel.
 */
export function buildBatchPromptSegments(goalSegments: readonly PromptSegment[], kind: CompletionKind = 'task'): PromptSegment[] {
  const batchGoal = assemblePrompt(goalSegments).trim().replace(/^\/goal\s*/i, '').trim();
  const payload = kind === 'qa'
    ? '{"type":"goal_complete","kind":"qa","result":"PASS|FAIL","summary":"...","observations":[{"claim":"...","evidence":"..."}],"notes":"...","failedCriteria":[{"id":"...","expected":"...","actual":"..."}],"requiredChecks":[{"command":"...","expected":"...","actual":"..."}]}'
    : kind === 'ac'
      ? '{"type":"goal_complete","kind":"ac_verification","result":"PASS|FAIL","summary":"...","failedCriteria":[{"id":"...","expected":"...","actual":"..."}]}'
      : '{"type":"goal_complete","kind":"task","summary":"..."}';
  const evidence = kind === 'qa' ? `\n${QA_ARTIFACT_INSTRUCTION}\n${QA_EVIDENCE_INSTRUCTION}\n${QA_E2E_INSTRUCTION}\n` : '';
  return [
    { label: 'goal', text: `AFK batch goal:\n${batchGoal}` },
    {
      label: 'completion protocol',
      text: `AFK batch completion protocol:\nWork only on the current checked-out branch. Do not switch branches or reset the branch. ${PUSH_BOUNDARY_INSTRUCTION} When running JavaScript tests, use a one-shot command such as \`pnpm vitest run\`; never use \`pnpm test\`, \`npm test\`, or bare \`vitest\`, because they may start watch mode and never finish.${evidence}When the task is complete, keep the work performed above and finish your response with exactly one machine-readable line in this format:\n<goal_complete>${payload}</goal_complete>\nThe marker must be valid JSON. Do not omit the marker.`,
    },
  ];
}

/**
 * The interactive prompt, as segments.
 *
 * The goal keeps its own segments, so the prompt that reaches the TUI says
 * which piece of it is what — and the completion protocol stays one piece,
 * because it is AFK's own fixed overhead.
 */
export function buildInteractivePromptSegments(goalSegments: readonly PromptSegment[], kind: CompletionKind = 'task'): PromptSegment[] {
  const payload = kind === 'qa'
    ? '{"type":"goal_complete","timestamp":"<current ISO-8601 time>","kind":"qa","result":"PASS|FAIL","summary":"...","observations":[{"claim":"...","evidence":"..."}],"notes":"...","failedCriteria":[{"id":"...","expected":"...","actual":"..."}],"requiredChecks":[{"command":"...","expected":"...","actual":"..."}]}'
    : kind === 'ac'
      ? '{"type":"goal_complete","timestamp":"<current ISO-8601 time>","kind":"ac_verification","result":"PASS|FAIL","summary":"...","failedCriteria":[{"id":"...","expected":"...","actual":"..."}]}'
      : '{"type":"goal_complete","timestamp":"<current ISO-8601 time>","kind":"task","summary":"..."}';
  const evidence = kind === 'qa' ? ` ${QA_ARTIFACT_INSTRUCTION} ${QA_EVIDENCE_INSTRUCTION} ${QA_E2E_INSTRUCTION}` : '';
  return [
    ...goalSegments,
    {
      label: 'completion protocol',
      text: `AFK interactive completion protocol: work only on the current checked-out branch. Do not switch branches or reset the branch. ${PUSH_BOUNDARY_INSTRUCTION}${evidence} When the task is complete, atomically write a valid JSON ${payload} to .afk-signal.json using a temporary file and rename. Construct the payload with JSON.stringify (or an equivalent JSON serializer); do not embed raw JSON in a shell printf command, because unescaped control characters make the signal invalid. After the rename, validate the exact file with JSON.parse before reporting completion. Use result PASS when QA passes, FAIL when QA fails, the actual current ISO-8601 timestamp, and a non-empty summary. Do not only print the completion marker.`,
    },
  ];
}

/**
 * The prompt AFK hands the provider, as segments.
 *
 * The goal segments come from the caller, because the caller knows what the
 * goal is made of: the task statement, the backlog title and the pointer to
 * the backlog context file.
 */
export function buildExecutionPromptSegments(
  goalSegments: readonly PromptSegment[],
  executionMode: ExecutionMode | undefined,
  kind: CompletionKind = 'task',
): PromptSegment[] {
  if (executionMode === 'batch') return buildBatchPromptSegments(goalSegments, kind);
  if (executionMode === 'interactive') return buildInteractivePromptSegments(goalSegments, kind);
  return [...goalSegments];
}

export function buildBatchPrompt(prompt: string, kind: CompletionKind = 'task'): string {
  return assemblePrompt(buildBatchPromptSegments([{ label: 'goal', text: prompt }], kind));
}

export function buildInteractivePrompt(prompt: string, kind: CompletionKind = 'task'): string {
  return assemblePrompt(buildInteractivePromptSegments([{ label: 'goal', text: prompt.trim() }], kind));
}

export function buildExecutionPrompt(prompt: string, executionMode: ExecutionMode | undefined, kind: CompletionKind = 'task'): string {
  if (executionMode === undefined) return prompt;
  return assemblePrompt(buildExecutionPromptSegments([{ label: 'goal', text: prompt.trim() }], executionMode, kind));
}
