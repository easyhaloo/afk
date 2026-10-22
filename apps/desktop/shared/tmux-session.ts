/**
 * tmux silently rewrites ':' to '_' when storing a session name; a name
 * containing ':' cannot be addressed with any escape form. Registry entries
 * store the original name (which tmux stores normalized), so every tmux
 * target must apply the same rewrite before `-t` lookups.
 */
export function normalizeTmuxSessionName(name: string): string {
  return name.replace(/:/g, "_");
}
