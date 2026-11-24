/**
 * Composer state and modals of an interactive agent TUI.
 *
 * Codex renders a placeholder ("Ask Codex to do anything") whenever its input
 * box is empty. A goal that was typed but never submitted keeps the box
 * filled, so the placeholder disappears. AFK uses that difference to tell
 * "the goal is still waiting for Enter" from "the agent accepted it".
 *
 * Claude Code marks its input line with a chevron instead. The composer is
 * the last chevron line on screen — everything above it is the conversation —
 * so the same question ("did the goal leave the composer?") has an answer.
 *
 * The distinction matters because an agent TUI opens modals of its own — most
 * notably the "Quick safety check" Claude Code shows for a directory it has
 * never seen, which is every fresh worktree. A modal grabs the keyboard and
 * swallows the Enter that submits the goal, and AFK cannot rely on the user
 * answering such a prompt: a goal that never reaches the agent leaves the run
 * hanging until the watchdog fires two hours later.
 */

/** Placeholder Codex renders while its composer is empty. */
export const CODEX_EMPTY_COMPOSER_MARKER = 'Ask Codex to do anything';

/** The chevron Claude Code renders in front of its composer. */
export const CLAUDE_COMPOSER_MARKER = '❯';

/**
 * A modal an agent TUI opened, and the keys that answer it.
 *
 * The keys are not the same for every modal. Claude Code's folder-trust
 * question highlights "No, exit" by default, so answering it with Enter
 * closes the agent and leaves the worktree untouched. The option AFK wants
 * has to be selected first.
 */
export interface AgentModal {
  /** Human-readable name for the run log. */
  name: string;
  /** Keys that move the selection onto the option AFK wants. */
  select: readonly string[];
  /** The key that confirms the selection. */
  confirm: string;
}

/**
 * True for providers whose composer state AFK can read from the tmux pane.
 *
 * Providers without a readable marker are reported as empty, so callers keep
 * their previous behaviour instead of blocking on a signal that never comes.
 */
export function supportsComposerState(provider: string): boolean {
  return provider === 'codex' || provider === 'claude-code';
}

/**
 * True when the composer holds no text.
 *
 * A goal that is still waiting for Enter keeps the composer filled, so the
 * difference between "filled" and "empty" is what tells AFK whether the agent
 * ever received the goal.
 */
export function composerIsEmpty(provider: string, paneText: string): boolean {
  if (provider === 'claude-code') return claudeComposerIsEmpty(paneText);
  if (!supportsComposerState(provider)) return true;
  return paneText.includes(CODEX_EMPTY_COMPOSER_MARKER);
}

/**
 * True when Claude Code's composer holds no text.
 *
 * The composer is the last chevron line on screen. A pane without one has no
 * composer to hold the goal, so nothing is waiting for Enter.
 */
export function claudeComposerIsEmpty(paneText: string): boolean {
  const lines = paneText.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trimStart();
    if (!line.startsWith(CLAUDE_COMPOSER_MARKER)) continue;
    return line.slice(CLAUDE_COMPOSER_MARKER.length).trim() === '';
  }
  return true;
}

/**
 * A modal rule: what proves the modal is on screen, and how to answer it.
 */
interface AgentModalRule {
  /** Human-readable name for the run log. */
  name: string;
  /** Text that proves this modal is the one on screen. */
  markers: readonly string[];
  /** Keys that move the selection onto the option AFK wants. */
  select: readonly string[];
  /** The key that confirms the selection. */
  confirm: string;
}

/**
 * Modals an agent TUI opens on its own, and the keys that answer them.
 *
 * A modal takes the keyboard. The Enter presses that submit the goal are
 * swallowed by it, and some of them — the folder trust question in
 * particular — restart the TUI afterwards, which leaves the goal in the
 * composer with no way for the agent to receive it.
 */
const MODAL_RULES: Readonly<Record<string, readonly AgentModalRule[]>> = {
  // Codex renders each modal as a numbered choice with the first one
  // selected, so Enter is the key that accepts it.
  codex: [
    { name: 'Trust this folder?', markers: ['Trust this folder?'], select: [], confirm: 'C-m' },
    { name: 'Update available', markers: ['Update available'], select: [], confirm: 'C-m' },
  ],
  'claude-code': [
    // Claude Code's "Quick safety check" highlights "No, exit" by default:
    // Enter closes the agent and the worktree stays untouched. The option
    // AFK wants is the second one, so the selection moves down first.
    { name: 'folder trust', markers: ['I trust this folder'], select: ['Down'], confirm: 'C-m' },
  ],
};

/**
 * The modal an agent TUI is showing, if any.
 *
 * Knowing which one it is lets AFK say so in the run log instead of leaving
 * a silent gap between "goal sent" and "goal never arrived" — and lets AFK
 * answer it the way the modal wants to be answered.
 */
export function agentModalInPane(provider: string, paneText: string): AgentModal | undefined {
  for (const rule of MODAL_RULES[provider] ?? []) {
    if (!rule.markers.some(marker => paneText.includes(marker))) continue;
    return { name: rule.name, select: rule.select, confirm: rule.confirm };
  }
  return undefined;
}
