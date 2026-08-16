import type { ExecutionMode } from '../agents/types';

export type CompletionKind = 'task' | 'qa' | 'ac';

export interface VerificationCriterion {
  id: string;
  expected: string;
  actual: string;
}

export interface AcVerificationFailure {
  type: 'goal_complete';
  kind: 'ac_verification';
  result: 'FAIL';
  summary: string;
  failedCriteria: VerificationCriterion[];
}

/** Parse the one provider-neutral completion marker accepted from agent text. */
export function extractGoalComplete(text: string): Record<string, unknown> | undefined {
  const match = text.match(/<goal_complete>([\s\S]*?)<\/goal_complete>/);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[1]!) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const payload = parsed as Record<string, unknown>;
    return { type: 'goal_complete', ...payload };
  } catch {
    return undefined;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseFailedCriteria(value: unknown): VerificationCriterion[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const criteria = value.map(entry => {
    if (!entry || typeof entry !== 'object') return undefined;
    const criterion = entry as Record<string, unknown>;
    if (!isNonEmptyString(criterion.id) || !isNonEmptyString(criterion.expected) || !isNonEmptyString(criterion.actual)) return undefined;
    return { id: criterion.id, expected: criterion.expected, actual: criterion.actual };
  });
  return criteria.some(entry => entry === undefined) ? undefined : criteria as VerificationCriterion[];
}

/** Only a complete diagnosis can safely drive an automatic AC correction. */
export function parseAcVerificationFailure(value: unknown): AcVerificationFailure | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result = value as Record<string, unknown>;
  const failedCriteria = parseFailedCriteria(result.failedCriteria);
  if (
    result.type !== 'goal_complete' || result.kind !== 'ac_verification' || result.result !== 'FAIL' ||
    !isNonEmptyString(result.summary) || !failedCriteria
  ) return undefined;
  return { type: 'goal_complete', kind: 'ac_verification', result: 'FAIL', summary: result.summary, failedCriteria };
}

export function isAcVerificationPass(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return result.type === 'goal_complete' && result.kind === 'ac_verification' && result.result === 'PASS' && isNonEmptyString(result.summary);
}

/**
 * Keep the task prompt provider-neutral while making the batch completion
 * contract explicit to the model. `/goal` remains ordinary prompt content;
 * only the output marker is owned by AFK.
 */
export function buildBatchPrompt(prompt: string, kind: CompletionKind = 'task'): string {
  const payload = kind === 'qa'
    ? '{"type":"goal_complete","kind":"qa","result":"PASS|FAIL","summary":"...","failedCriteria":[{"id":"...","expected":"...","actual":"..."}],"requiredChecks":[{"command":"...","expected":"..."}]}'
    : kind === 'ac'
      ? '{"type":"goal_complete","kind":"ac_verification","result":"PASS|FAIL","summary":"...","failedCriteria":[{"id":"...","expected":"...","actual":"..."}]}'
      : '{"type":"goal_complete","kind":"task","summary":"..."}';
  const marker = `<goal_complete>${payload}</goal_complete>`;
  return `${prompt.trim()}\n\nAFK batch completion protocol:\nWork only on the current checked-out branch. Do not switch branches or reset the branch. When running JavaScript tests, use a one-shot command such as \`pnpm vitest run\`; never use \`pnpm test\`, \`npm test\`, or bare \`vitest\`, because they may start watch mode and never finish. When the task is complete, keep the work performed above and finish your response with exactly one machine-readable line in this format:\n${marker}\nThe marker must be valid JSON. Do not omit the marker.`;
}

/**
 * Interactive Claude sessions do not expose a parseable stdout stream. Inject
 * the same typed completion contract into the prompt so LocalAgentExecution
 * can observe the atomically-written signal file.
 */
export function buildInteractivePrompt(prompt: string, kind: CompletionKind = 'task'): string {
  const payload = kind === 'qa'
    ? '{"type":"goal_complete","timestamp":"<current ISO-8601 time>","kind":"qa","result":"PASS|FAIL","summary":"...","failedCriteria":[{"id":"...","expected":"...","actual":"..."}],"requiredChecks":[{"command":"...","expected":"..."}]}'
    : kind === 'ac'
      ? '{"type":"goal_complete","timestamp":"<current ISO-8601 time>","kind":"ac_verification","result":"PASS|FAIL","summary":"...","failedCriteria":[{"id":"...","expected":"...","actual":"..."}]}'
      : '{"type":"goal_complete","timestamp":"<current ISO-8601 time>","kind":"task","summary":"..."}';
  return `${prompt.trim()} AFK interactive completion protocol: work only on the current checked-out branch. Do not switch branches or reset the branch. When the task is complete, atomically write a valid JSON ${payload} to .afk-signal.json using a temporary file and rename. Construct the payload with JSON.stringify (or an equivalent JSON serializer); do not embed raw JSON in a shell printf command, because unescaped control characters make the signal invalid. After the rename, validate the exact file with JSON.parse before reporting completion. Use result PASS when QA passes, FAIL when QA fails, the actual current ISO-8601 timestamp, and a non-empty summary. Do not only print the completion marker.`;
}

export function buildExecutionPrompt(prompt: string, executionMode: ExecutionMode | undefined, kind: CompletionKind = 'task'): string {
  if (executionMode === 'batch') return buildBatchPrompt(prompt, kind);
  if (executionMode === 'interactive') return buildInteractivePrompt(prompt, kind);
  return prompt;
}
