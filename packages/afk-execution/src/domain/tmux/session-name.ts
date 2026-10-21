/**
 * tmux silently rewrites ':' to '_' when storing a session name (verified on
 * tmux 3.6a; the stored name cannot be addressed with any escape of ':').
 * Backlog ids like `github:easyhaloo/afk#144` therefore create a session
 * under a different name than the runner keeps looking up, and every
 * `session:window` target resolves wrong ("can't find window"). Applying the
 * same rewrite ourselves before create/lookup keeps both sides identical.
 *
 * The rule is about tmux, not about any one of the callers that has to
 * address a session, so it lives here rather than being written again by
 * each of them.
 */
export function normalizeTmuxSessionName(name: string): string {
  return name.replace(/:/g, '_');
}

/**
 * The tmux session a work item runs in.
 *
 * The runtime names the session and the desktop recognises it by the
 * name. Each of them used to spell the name out, and the runtime
 * spelled it with two different work item identities - the canonical
 * one where it had it and the tracker's number where it did not. A
 * change on either side left the other unable to recognise the sessions
 * the first had just created.
 */
export function tmuxSessionNameFor(workItemId: string): string {
  return `afk-${workItemId}`;
}
