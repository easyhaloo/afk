import type { BrowserPort, ConfigurationPort, TmuxPort } from '@afk/application';

/**
 * What the board asks of the runtime.
 *
 * The board reads a tracker, shows what is running and opens a link. Three
 * of those reach outside the process, and the board must not be the thing
 * that knows how: it asks for a capability and the composition root says
 * what that capability is.
 *
 * The board asks for three narrow slices, not the whole runtime, so that a
 * view cannot reach a capability the board has no business using.
 */
export interface BoardRuntimePorts {
  /** The tracker connection the board reads its work from. */
  configuration: Pick<ConfigurationPort, 'gitLab'>;
  /** The terminal session a run can be attached to. */
  tmux: Pick<TmuxPort, 'attach'>;
  /** The operating system's browser, for the links the board shows. */
  browser: Pick<BrowserPort, 'open'>;
}
