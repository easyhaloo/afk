export interface GoalCompletePayload {
  type: 'goal_complete';
  [key: string]: unknown;
}

/**
 * Parse the provider-neutral completion marker accepted from agent output.
 *
 * The marker is `<goal_complete>{...}</goal_complete>`. A payload that names
 * another signal type is not a goal_complete and is rejected here rather
 * than handed on for each transport to reject differently. A payload without
 * a type is a goal_complete: it is the only completion signal the protocol
 * defines, and the transports used to disagree about it — the batch path
 * accepted such a payload and the container path rejected it, so the same
 * agent output completed on one sandbox and failed on another.
 */
export function extractGoalComplete(text: string): GoalCompletePayload | undefined {
  const match = text.match(/<goal_complete>([\s\S]*?)<(?:\\)?\/goal_complete>/);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[1]!) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (record.type !== undefined && record.type !== 'goal_complete') return undefined;
    return { ...record, type: 'goal_complete' };
  } catch {
    return undefined;
  }
}

/**
 * Does a completion carry the signal the caller expected?
 *
 * A `completed` result whose payload is missing, or names another signal, is
 * not a completion — the agent said nothing the runner can act on. Every
 * transport checks this before reporting a completion; the runner checks it
 * again, because a transport that forgot is exactly the case worth
 * catching.
 */
export function carriesExpectedSignal(output: unknown, signalType: string): boolean {
  if (!output || typeof output !== 'object') return false;
  return (output as { type?: unknown }).type === signalType;
}
