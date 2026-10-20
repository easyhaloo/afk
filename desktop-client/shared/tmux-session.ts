/**
 * tmux silently rewrites ':' to '_' when storing a session name; a name
 * containing ':' cannot be addressed with any escape form. Registry entries
 * store the original name (which tmux stores normalized), so every tmux
 * target must apply the same rewrite before `-t` lookups.
 *
 * The rule itself is the execution package's — it is about tmux, and the
 * runner applies it too. The desktop re-exports it so both sides name the
 * same rewrite.
 */
export { normalizeTmuxSessionName } from "@afk/execution/domain/tmux/session-name";
