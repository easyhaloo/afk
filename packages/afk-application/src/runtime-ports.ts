import type {
  AgentProviderName,
  AgentReadiness,
  AgentTelemetryProvider,
  AgentToolCallSummary,
  AfkResourceRecord,
  SandboxKind,
  Signal,
  TmuxCaptureOptions,
  TmuxSession,
  TokenUsage,
} from '@afk/core';

/**
 * The ports the execution runtime is reached through.
 *
 * The runtime does real work in the outside world: it runs tmux, it spawns
 * a daemon, it reads a harness's transcript, it opens a browser and it keeps
 * a registry of what it handed out. An entry point that reaches for one of
 * those things directly has to know how it is done - which class to
 * construct, which file to read, which process to signal - and that is a
 * decision the entry point should not be making.
 *
 * So the runtime is described here, as the capabilities an entry point
 * needs, and the implementation of each is chosen in a composition root.
 * A command, a view or a service states what it needs; the composition root
 * says what it is wired to.
 */

/**
 * The tmux sessions a run is driven through.
 *
 * The runtime drives a session; an entry point that wants to watch one, or
 * to open a terminal on it, asks for the session rather than for the tmux
 * client that happens to implement it.
 */
export interface TmuxPort {
  /** Create a session and return what it looks like. */
  createSession(name: string, dir: string, command?: string): Promise<TmuxSession>;
  /** Whether the session is still there. */
  hasSession(name: string): Promise<boolean>;
  /** Close the session. */
  killSession(name: string): Promise<void>;
  /** Type a prompt into the session and let the agent work on it. */
  sendPrompt(
    worktreeDir: string,
    session: string,
    window: string,
    prompt: string,
    signalType: string,
    readiness: AgentReadiness,
  ): Promise<void>;
  /** Read the pane. */
  capturePane(session: string, window: string, options?: TmuxCaptureOptions): Promise<string>;
  /** Wait for the session to carry a signal. */
  waitForSignal(
    session: string,
    window: string,
    signalType: Signal['type'],
    worktreeDir: string,
    timeout?: number,
  ): Promise<Signal | null>;
  /** Attach the terminal to the session. */
  attach(session: string): Promise<boolean>;
  /** What an agent has to show before it can be driven. */
  readiness(agent: AgentProviderName): AgentReadiness;
}

/** How a loop daemon is started. */
export interface LoopDaemonSpawn {
  executable: string;
  script: string;
  args: string[];
  env: Record<string, string | undefined>;
}

/**
 * The signals a loop daemon is stopped with.
 *
 * The daemon is asked to stop first and killed only if it does not, so
 * the two signals are named rather than spelled out at the call site.
 */
export type LoopTerminationSignal = 'SIGTERM' | 'SIGKILL';

/**
 * The loop daemon's process.
 *
 * The daemon is a process that outlives the command that started it, and
 * it is found again through a pid file. Both of those are the runtime's
 * business: an entry point says "start it" or "is it running", and does
 * not read a pid file or send a signal itself.
 */
export interface LoopProcessPort {
  /** Where the daemon's pid is recorded. */
  pidFile(): string;
  /** Make sure the pid file's directory exists. */
  ensurePidDirectory(): void;
  /** The recorded pid, when there is one. */
  readPid(): number | null;
  /** Forget the recorded pid. */
  removePidFile(): void;
  /** Whether a process is still running. */
  isAlive(pid: number): boolean;
  /** Start the daemon and return its pid. */
  spawnDaemon(options: LoopDaemonSpawn): number | undefined;
  /** Wait for the daemon to record its pid. */
  waitForPid(timeoutMs: number): Promise<number | null>;
  /**
   * Ask the daemon to stop.
   *
   * The daemon is the runtime's, and so is the way it is stopped: a
   * caller that signals the pid itself has to know the pid file's
   * convention, and the signal the daemon expects to see.
   */
  terminate(pid: number, signal: LoopTerminationSignal): void;
}

/** What a transcript is read for. */
export interface AgentTelemetryOptions {
  provider: AgentTelemetryProvider;
  transcriptPath: string;
  sandboxKind: SandboxKind;
}

/**
 * The harness transcripts AFK reads.
 *
 * AFK only reads: the harness owns what happened, and AFK reports it. A
 * retro gathers its evidence here, and a command that reports on a run
 * asks for the same evidence rather than reading the harness's files
 * itself.
 */
export interface AgentTelemetryPort {
  /** The tokens the agent's run cost. */
  readUsage(options: AgentTelemetryOptions): Promise<TokenUsage | undefined>;
  /** The transcript itself. */
  readTranscript(options: AgentTelemetryOptions): Promise<string | undefined>;
  /** The tool calls the transcript records. */
  readTools(options: AgentTelemetryOptions): Promise<AgentToolCallSummary[] | undefined>;
  /** Where the harness keeps a run's rollout, when it keeps one. */
  findRollout(threadId: string, rootDir?: string): Promise<string | undefined>;
}

/**
 * The operating system's default browser.
 *
 * Opening a link is a thing the user asked for, and a thing that reaches
 * out of the process. The port is one method, because that is all it is.
 */
export interface BrowserPort {
  open(url: string): Promise<void>;
}

/**
 * The registry of the resources runs handed out.
 *
 * The registry owns the table and the rows in it. A reader asks it what is
 * there, so a change to the table does not leave a reader querying a
 * column that is no longer there.
 */
export interface ResourceRegistryPort {
  /** The live resources of the given workspaces. */
  readActive(workspaces: readonly string[]): AfkResourceRecord[];
  /** The resources one run handed out. */
  readRun(runId: string): AfkResourceRecord[];
}

/**
 * The environment a run is in, and the way to stop it.
 *
 * A run's agent is a process in a terminal session, and a run lives in
 * another process. Somebody who stops the run from outside - the desktop
 * client, an operator - cannot call into the running agent, so the request
 * has to travel through something both sides can see.
 *
 * Stopping a run has to stop that process. A tracker that says the run is
 * blocked while the agent keeps working is a run that is not stopped, and
 * the agent keeps spending the budget the stop was meant to end.
 */
export interface RunSessionPort {
  /**
   * Stop the agent of a run.
   *
   * The run's own session is the one that is stopped, and only that one.
   * A run that has no session - because it never started one, or because
   * it already ended - has nothing to stop, and that is not a failure.
   */
  stop(runId: string): Promise<boolean>;
}
