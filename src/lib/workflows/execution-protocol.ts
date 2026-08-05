import type { ExecutionMode } from '../agents/types';

export type CompletionKind = 'task' | 'qa';

/**
 * Keep the task prompt provider-neutral while making the batch completion
 * contract explicit to the model. `/goal` remains ordinary prompt content;
 * only the output marker is owned by AFK.
 */
export function buildBatchPrompt(prompt: string, kind: CompletionKind = 'task'): string {
  const payload = kind === 'qa'
    ? '{"type":"goal_complete","kind":"qa","result":"PASS","summary":"..."}'
    : '{"type":"goal_complete","kind":"task","summary":"..."}';
  const marker = `<goal_complete>${payload}</goal_complete>`;
  return `${prompt.trim()}\n\nAFK batch completion protocol:\nWhen the task is complete, keep the work performed above and finish your response with exactly one machine-readable line in this format:\n${marker}\nThe marker must be valid JSON. Do not omit the marker.`;
}

export function buildExecutionPrompt(prompt: string, executionMode: ExecutionMode | undefined, kind: CompletionKind = 'task'): string {
  return executionMode === 'batch' ? buildBatchPrompt(prompt, kind) : prompt;
}
