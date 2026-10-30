/**
 * Composer state of an interactive agent TUI.
 *
 * Codex renders a placeholder ("Ask Codex to do anything") whenever its input
 * box is empty. A goal that was typed but never submitted keeps the box
 * filled, so the placeholder disappears. AFK uses that difference to tell
 * "the goal is still waiting for Enter" from "the agent accepted it".
 *
 * The distinction matters because the Codex TUI opens modals of its own — most
 * notably the "Update available" prompt, which grabs the keyboard and
 * swallows the Enter that submits the goal. AFK cannot rely on the user
 * answering such a prompt, and a goal that never reaches the agent leaves the
 * run hanging until the watchdog fires two hours later.
 */

/** Placeholder Codex renders while its composer is empty. */
export const CODEX_EMPTY_COMPOSER_MARKER = 'Ask Codex to do anything';

/**
 * True for providers whose composer state AFK can read from the tmux pane.
 *
 * Claude Code has no equivalent marker AFK can rely on, so its composer state
 * stays unobserved and AFK keeps its previous behaviour.
 */
export function supportsComposerState(provider: string): boolean {
  return provider === 'codex';
}

/**
 * True when the composer holds no text.
 *
 * Providers without a readable marker are reported as empty so callers keep
 * their previous behaviour instead of blocking on a signal that never comes.
 */
export function composerIsEmpty(provider: string, paneText: string): boolean {
  if (!supportsComposerState(provider)) return true;
  return paneText.includes(CODEX_EMPTY_COMPOSER_MARKER);
}
