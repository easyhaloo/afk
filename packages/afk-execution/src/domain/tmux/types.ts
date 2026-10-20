import type { AgentProviderName } from '../agents/types.js';

/**
 * The tmux vocabulary, and the seam a sandbox drives a session through.
 *
 * These shapes describe a session, not a process.  The client that
 * implements them lives in the infrastructure layer, where the tmux binary
 * does; the runner and the sandbox speak in these terms, so the terms live
 * here rather than being imported from the implementation beside them.
 */

/** A tmux session, as the runner names it. */
export interface TmuxSession {
  name: string;
  window: string;
  dir: string;
  status?: string;
  created?: string;
  /** tmux-native pane id (e.g. %0) when known — exact ADR-0019 target. */
  paneId?: string;
}

/** How much of a pane to read. */
export interface TmuxCaptureOptions {
  lines?: number;
  history?: number;
}

/** What a readiness rule is asked about. */
export type ReadinessContext = {
  /** The worktree the agent runs in. */
  worktreeDir: string;
  /** The tmux session, when the agent runs in one. */
  session?: string;
  /** Whether the tmux session exists — the tmux client's own answer. */
  sessionExists: (session: string) => Promise<boolean>;
};

/**
 * What one agent has to show before it can be driven.
 *
 * The tmux session exists as soon as the shell does, which is not the same
 * as the agent being ready: the CLI has to start, and a prompt typed into a
 * shell that has not started the agent is a prompt nobody sees.
 */
export type AgentReadiness = {
  /** The agent the rule is about, for the message when it never comes up. */
  agent: AgentProviderName;
  /** Whether the agent is up yet. */
  ready: (context: ReadinessContext) => Promise<boolean>;
};

/**
 * The tmux seam a sandbox drives a session through.
 *
 * The sandbox owns no session: it asks for one, sends a prompt, reads the
 * pane and closes it.  That is the whole of what it needs, so that is what
 * the seam says.  The client offers more than this and the sandbox asks for
 * less, and naming the difference here is what keeps the sandbox from
 * depending on the client it happens to be handed.
 */
export interface SandboxTmux {
  createSession(name: string, dir: string, command?: string): Promise<TmuxSession>;
  firstPaneId?(session: string, window: string): Promise<string | undefined>;
  /**
   * Whether the session is still there.
   *
   * The session is the agent in interactive mode: when it ends, the agent
   * ended. An execution that can ask finds out in seconds instead of
   * waiting out the completion timeout to find out.
   */
  hasSession?(session: string): Promise<boolean>;
  closeSession(): void;
  killSession(name: string): Promise<void>;
  sendPrompt(
    worktreeDir: string,
    session: string,
    window: string,
    prompt: string,
    signalType: string,
    readiness: AgentReadiness,
  ): Promise<void>;
  sendKeys(session: string, window: string, keys: string | string[]): Promise<void>;
  capturePane(session: string, window: string, options?: TmuxCaptureOptions): Promise<string>;
}
