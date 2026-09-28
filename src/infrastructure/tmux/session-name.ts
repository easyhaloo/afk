/**
 * tmux silently rewrites ':' to '_' when storing a session name (verified on
 * tmux 3.6a; the stored name cannot be addressed with any escape of ':').
 * Backlog ids like `github:easyhaloo/afk#144` therefore create a session
 * under a different name than the runner keeps looking up, and every
 * `session:window` target resolves wrong ("can't find window"). Applying the
 * same rewrite ourselves before create/lookup keeps both sides identical.
 */
export function normalizeTmuxSessionName(name: string): string {
  return name.replace(/:/g, '_');
}
