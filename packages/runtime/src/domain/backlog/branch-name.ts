/**
 * The Git branch of a backlog item.
 *
 * The branch is named after the issue number, never after the identity
 * string: two repositories with the same issue number must not produce the
 * same branch name, and the identity string would change that name whenever
 * the project key changes.
 */
export function deriveBacklogBranchName(id: string): string {
  const normalized = id.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized) throw new Error('backlog id must contain at least one usable character');
  return `afk/backlog-${normalized}`;
}
