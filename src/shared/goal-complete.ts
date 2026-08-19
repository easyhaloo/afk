export interface GoalCompletePayload {
  type: 'goal_complete';
  [key: string]: unknown;
}

/** Parse the provider-neutral completion marker accepted from agent output. */
export function extractGoalComplete(text: string): GoalCompletePayload | undefined {
  const match = text.match(/<goal_complete>([\s\S]*?)<(?:\\)?\/goal_complete>/);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[1]!) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return { type: 'goal_complete', ...parsed };
  } catch {
    return undefined;
  }
}
