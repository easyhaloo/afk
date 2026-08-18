/**
 * Provider-internal label metadata.  Platform adapters persist these values
 * as labels, but callers only ever see canonical states, modes and tags.
 */
export const INTERNAL_LABEL_PREFIXES = [
  'stage::',
  'mode::',
  'parent::',
  'depends-on::',
  'depends_on::',
] as const;

export function isInternalBacklogLabel(label: string): boolean {
  return INTERNAL_LABEL_PREFIXES.some(prefix => label.startsWith(prefix));
}

/** State and mode labels are replaced on every canonical transition. */
export function isWorkflowMetadataLabel(label: string): boolean {
  return label.startsWith('stage::') || label.startsWith('mode::');
}

/** Return user/business tags while preserving their provider order. */
export function extractBacklogTags(labels: readonly string[]): string[] {
  return [...new Set(labels.filter(label => !isInternalBacklogLabel(label)))];
}

export function validateBusinessTag(tag: string): string {
  const normalized = tag.trim();
  if (!normalized) throw new Error('backlog tag must not be empty');
  if (isInternalBacklogLabel(normalized)) {
    throw new Error(`backlog tag is reserved for provider metadata: ${normalized}`);
  }
  return normalized;
}
