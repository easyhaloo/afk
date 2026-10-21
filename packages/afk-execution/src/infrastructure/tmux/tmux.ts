import { spawn } from 'child_process';
import type { Signal } from '@afk/core';
import { logger, readSignal, readSignalSync } from '@afk/infrastructure';
import { ControlModeConnection, type ControlModeOutputCallback } from './control-mode.js';
import { normalizeTmuxSessionName } from '@afk/core';
import type { AgentReadiness, TmuxCaptureOptions, TmuxSession } from '@afk/core';

export { normalizeTmuxSessionName };

export type { TmuxCaptureOptions, TmuxSession };

type SignalReaders = { readSignal: typeof readSignal; readSignalSync: typeof readSignalSync };

/**
 * The part of a Control Mode connection this client uses.
 *
 * The connection itself talks to tmux over a pipe, which needs a terminal
 * the test runner does not have. Naming what the client needs leaves the
 * pane-watching path open to a test that can drive it.
 */
export interface ControlModeChannel {
  onOutput(callback: ControlModeOutputCallback): void;
  offOutput(callback: ControlModeOutputCallback): void;
  sendRawCommand(command: string): void;
  close(): void;
}

/**
 * Tmux client wrapper for session management.
 *
 * Uses Control Mode (`tmux -CC`) for interactive operations (sendKeys, waitForSignal)
 * to receive real-time events, and plain `exec()` for one-shot commands.
 */
export class TmuxClient {
  private controlMode: ControlModeChannel | null = null;
  private currentSession: string | null = null;

  constructor(
    private readonly signalReaders: SignalReaders = { readSignal, readSignalSync },
    private readonly connectControlMode: (session: string) => ControlModeChannel = session =>
      new ControlModeConnection({ session, pauseAfter: 1 }),
  ) {}

  /**
   * Open a Control Mode connection to a session.
   * Subsequent sendKeys will use this connection for event-driven output.
   */
  async openSession(session: string): Promise<void> {
    this.closeSession();
    const normalized = normalizeTmuxSessionName(session);
    this.controlMode = this.connectControlMode(normalized);
    this.currentSession = normalized;
  }

  /**
   * Close the Control Mode connection.
   */
  closeSession(): void {
    if (this.controlMode) {
      this.controlMode.close();
      this.controlMode = null;
      this.currentSession = null;
    }
  }

  /**
   * Check if tmux is available
   */
  static isAvailable(): boolean {
    try {
      const result = spawn('tmux', ['-V'], { stdio: 'pipe' });
      return result.pid !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * Create new tmux session, replacing any existing session with the same name.
   */
  async createSession(name: string, dir: string, command: string = 'claude --dangerously-skip-permissions'): Promise<TmuxSession> {
    const window = 'main';
    const session = normalizeTmuxSessionName(name);
    // Kill any existing session first to avoid "duplicate session" errors.
    await this.killSession(session).catch(() => { /* ignore if not exists */ });
    await this.exec([
      'new-session',
      '-d',
      '-s', session,
      '-n', window,
      '-c', dir,
      command,
    ]);
    const paneId = await this.firstPaneId(session, window).catch(() => undefined);
    return { name: session, window, dir, ...(paneId ? { paneId } : {}) };
  }

  /**
   * First pane id of a window — the exact ADR-0019 control target component.
   * `#{pane_id}` (e.g. %0) survives window renames and never collides across
   * sessions in the same tmux server.
   */
  async firstPaneId(session: string, window: string): Promise<string | undefined> {
    try {
      const output = await this.exec(['list-panes', '-t', `${normalizeTmuxSessionName(session)}:${window}`, '-F', '#{pane_id}']);
      return output.split('\n').map(line => line.trim()).filter(Boolean)[0];
    } catch {
      return undefined;
    }
  }

  /**
   * Check if session exists
   */
  async hasSession(name: string): Promise<boolean> {
    try {
      await this.exec(['has-session', '-t', normalizeTmuxSessionName(name)]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Kill tmux session
   */
  async killSession(name: string): Promise<void> {
    await this.exec(['kill-session', '-t', normalizeTmuxSessionName(name)]);
  }

  /**
   * Create a new window in an existing session with a command
   */
  async newWindow(session: string, command: string): Promise<void> {
    await this.exec(['new-window', '-t', normalizeTmuxSessionName(session), '-d', command]);
  }

  /**
   * List windows in a session
   */
  async listWindows(session: string): Promise<string[]> {
    try {
      const output = await this.exec(['list-windows', '-t', normalizeTmuxSessionName(session), '-F', '#{window_name}']);
      if (!output) return [];
      return output.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Check if we're running inside a tmux client
   */
  isInsideTmux(): boolean {
    return !!process.env.TMUX;
  }

  /**
   * Attach to a tmux session.
   * - Inside tmux: creates a new window in the target session (avoids duplicate)
   * - Outside tmux: switches client to the target session
   * Returns true if session exists and attach was initiated.
   */
  async attach(session: string): Promise<boolean> {
    if (!await this.hasSession(session)) return false;
    const windows = await this.listWindows(session);
    if (windows.length === 0) return false;

    if (this.isInsideTmux()) {
      // Inside tmux: create a new window in the target session (no duplicate attach)
      await this.newWindow(session, `tmux attach -t ${normalizeTmuxSessionName(session)}`);
    } else {
      // Outside tmux: switch to the session
      await this.exec(['switch-client', '-t', `${normalizeTmuxSessionName(session)}:${windows[0]}`]);
    }
    return true;
  }

  /**
   * Send keys to session.
   * Uses Control Mode connection if open, otherwise falls back to exec.
   * Auto-opens Control Mode on first use if not already connected.
   */
  async sendKeys(session: string, window: string, keys: string | string[]): Promise<void> {
    const target = `${normalizeTmuxSessionName(session)}:${window}`;
    const keyArray = Array.isArray(keys) ? keys : [keys];

    // Auto-open Control Mode if not connected
    const normalized = normalizeTmuxSessionName(session);
    if (!this.controlMode || this.currentSession !== normalized) {
      await this.openSession(normalized);
    }

    // Use Control Mode for batched command sending
    for (const key of keyArray) {
      this.controlMode!.sendRawCommand(`send-keys -t ${target} -- ${key}`);
      this.controlMode!.sendRawCommand('send-keys -t ' + target + ' C-m');
      await this.sleep(100);
    }
  }

  /**
   * Capture pane content
   */
  async capturePane(session: string, window: string, options: TmuxCaptureOptions = {}): Promise<string> {
    const { lines = 50, history = 100 } = options;
    const target = `${normalizeTmuxSessionName(session)}:${window}`;
    try {
      const output = await this.exec([
        'capture-pane', '-t', target, '-p', '-S', `-${history}`,
      ]);
      const allLines = output.split('\n');
      return allLines.slice(-lines).join('\n');
    } catch {
      return '(capture failed)';
    }
  }

  /**
   * Wait for the agent to be ready for input.
   *
   * What "ready" means is the agent's own business: the tmux wrapper asks
   * the readiness rule, and the rule says which marker to watch. A wrapper
   * that knew the roster would have to be changed every time the roster
   * changed.
   */
  async waitForPrompt(
    worktreeDir: string,
    timeout: number,
    readiness: AgentReadiness,
    session?: string,
  ): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await readiness.ready({ worktreeDir, session, sessionExists: name => this.hasSession(name) })) return true;
      await this.sleep(500);
    }
    return false;
  }

  /**
   * Send /goal command with text, followed by instructions to write signal.
   * @param signalType - The signal type to write on completion (default: 'goal_complete')
   */
  async sendPrompt(
    worktreeDir: string,
    session: string,
    window: string,
    prompt: string,
    signalType: string = 'goal_complete',
    readiness: AgentReadiness,
  ): Promise<void> {
    const hasPrompt = await this.waitForPrompt(worktreeDir, 30000, readiness, session);
    if (!hasPrompt) throw new Error(`Timeout waiting for ${readiness.agent} prompt`);

    // Type the prompt text directly (which already contains `/goal ` prefix).
    // The text is submitted as a single line
    // (no embedded newlines which would cause premature submission in the TUI).
    await this.exec(['send-keys', '-t', `${normalizeTmuxSessionName(session)}:${window}`, '--', prompt]);
    await this.sleep(500);

    // After the agent completes the goal, it reports completion via
    // ExecutionResult (structured output).
    //
    // Double-tap C-m to submit: the first Enter can be lost if the TUI is
    // mid-redraw on a long wrapped line; the second is a harmless no-op.
    await this.exec(['send-keys', '-t', `${normalizeTmuxSessionName(session)}:${window}`, 'C-m']);
    await this.sleep(300);
    await this.exec(['send-keys', '-t', `${normalizeTmuxSessionName(session)}:${window}`, 'C-m']);
  }

  /**
   * Wait for the signal file to carry a specific type.
   *
   * The file is read before the wait starts, and again whenever the pane
   * produces output. The pane tells us that something changed, not that
   * this file changed, so a signal that was already on disk when the wait
   * began would otherwise wait for output that never comes.
   *
   * A file that is there and cannot be read ends the wait: no signal will
   * ever come from it, and the caller has something else to fall back on.
   */
  async waitForSignal(
    session: string,
    window: string,
    signalType: Signal['type'],
    worktreeDir: string,
    timeout: number = 300000
  ): Promise<Signal | null> {
    const existing = await this.readOutcome(worktreeDir, signalType);
    if (existing.signal) return existing.signal;
    if (existing.broken) return null;

    // Try Control Mode first if connected to this session
    if (this.controlMode && this.currentSession === normalizeTmuxSessionName(session)) {
      // The channel is held locally: the connection can be closed while
      // the wait is still open, and a wait that outlives its channel must
      // end quietly rather than throw on the way out.
      const channel = this.controlMode;
      return new Promise<Signal | null>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        let settled = false;
        const finish = (signal: Signal | null): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          channel.offOutput(outputHandler);
          resolve(signal);
        };
        const outputHandler = (_pane: string, _text: string): void => {
          // When we see the signal file written, resolve
          const outcome = this.readOutcomeSync(worktreeDir, signalType);
          if (outcome.signal) finish(outcome.signal);
          else if (outcome.broken) finish(null);
        };

        // Timeout fallback
        timer = setTimeout(() => finish(null), timeout);
        channel.onOutput(outputHandler);
      });
    }

    // Fallback: filesystem polling
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const outcome = await this.readOutcome(worktreeDir, signalType);
      if (outcome.signal) return outcome.signal;
      if (outcome.broken) return null;
      await this.sleep(2000);
    }
    return null;
  }

  /**
   * What the signal file holds right now.
   *
   * The reader throws when the file is there and cannot be read. Inside a
   * wait that is not a crash: the file is broken, no signal will ever come
   * from it, and the wait is over. The reason is logged, because a wait
   * that ends with nothing otherwise looks exactly like a wait that timed
   * out.
   */
  private async readOutcome(worktreeDir: string, signalType: Signal['type']): Promise<{ signal: Signal | null; broken: boolean }> {
    try {
      const signal = await this.signalReaders.readSignal(worktreeDir);
      return { signal: signal && signal.type === signalType ? signal : null, broken: false };
    } catch (error) {
      logger.warn({ worktreeDir, err: error }, 'the signal file could not be read; no signal will come from it');
      return { signal: null, broken: true };
    }
  }

  /** The same question, asked from a synchronous callback. */
  private readOutcomeSync(worktreeDir: string, signalType: Signal['type']): { signal: Signal | null; broken: boolean } {
    try {
      const signal = this.signalReaders.readSignalSync(worktreeDir);
      return { signal: signal && signal.type === signalType ? signal : null, broken: false };
    } catch (error) {
      logger.warn({ worktreeDir, err: error }, 'the signal file could not be read; no signal will come from it');
      return { signal: null, broken: true };
    }
  }

  private async exec(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('tmux', args, { stdio: 'pipe' });
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (data) => { stdout += data.toString(); });
      proc.stderr?.on('data', (data) => { stderr += data.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`tmux command failed: ${stderr || stdout}`));
      });
      proc.on('error', reject);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
