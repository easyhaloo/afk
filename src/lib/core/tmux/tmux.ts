import { spawn } from 'child_process';
import { Signal } from '../../schemas';
import { readSignal, readSignalSync } from '../io/signal';
import { TIMEOUTS } from '../../constants';
import { ControlModeConnection } from './control-mode';

export interface TmuxSession {
  name: string;
  window: string;
  dir: string;
  status?: string;
  created?: string;
}

export interface TmuxCaptureOptions {
  lines?: number;
  history?: number;
}

/**
 * Tmux client wrapper for session management.
 *
 * Uses Control Mode (`tmux -CC`) for interactive operations (sendKeys, waitForSignal)
 * to receive real-time events, and plain `exec()` for one-shot commands.
 */
export class TmuxClient {
  private controlMode: ControlModeConnection | null = null;
  private currentSession: string | null = null;

  /**
   * Open a Control Mode connection to a session.
   * Subsequent sendKeys will use this connection for event-driven output.
   */
  async openSession(session: string): Promise<void> {
    this.closeSession();
    this.controlMode = new ControlModeConnection({ session, pauseAfter: 1 });
    this.currentSession = session;
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
    // Kill any existing session first to avoid "duplicate session" errors.
    await this.killSession(name).catch(() => { /* ignore if not exists */ });
    await this.exec([
      'new-session',
      '-d',
      '-s', name,
      '-n', window,
      '-c', dir,
      command,
    ]);
    // Bypass the workspace trust dialog by auto-confirming.
    await this.sleep(2000);
    await this.exec(['send-keys', '-t', `${name}:${window}`, '--', 'Enter']);
    return { name, window, dir };
  }

  /**
   * Check if session exists
   */
  async hasSession(name: string): Promise<boolean> {
    try {
      await this.exec(['has-session', '-t', name]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all tmux sessions
   */
  async listSessions(): Promise<TmuxSession[]> {
    try {
      const output = await this.exec(['list-sessions', '-F', '#{session_name}:#{window_name}:#{session_dir}:#{session_status}:#{session_created}']);
      if (!output) return [];
      return output.split('\n').filter(Boolean).map(line => {
        const [name, window, dir, status, created] = line.split(':');
        return { name, window, dir, status, created };
      });
    } catch {
      return [];
    }
  }

  /**
   * Kill tmux session
   */
  async killSession(name: string): Promise<void> {
    await this.exec(['kill-session', '-t', name]);
  }

  /**
   * Create a new window in an existing session with a command
   */
  async newWindow(session: string, command: string): Promise<void> {
    await this.exec(['new-window', '-t', session, '-d', command]);
  }

  /**
   * List windows in a session
   */
  async listWindows(session: string): Promise<string[]> {
    try {
      const output = await this.exec(['list-windows', '-t', session, '-F', '#{window_name}']);
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
      await this.newWindow(session, `tmux attach -t ${session}`);
    } else {
      // Outside tmux: switch to the session
      await this.exec(['switch-client', '-t', `${session}:${windows[0]}`]);
    }
    return true;
  }

  /**
   * Send keys to session.
   * Uses Control Mode connection if open, otherwise falls back to exec.
   * Auto-opens Control Mode on first use if not already connected.
   */
  async sendKeys(session: string, window: string, keys: string | string[]): Promise<void> {
    const target = `${session}:${window}`;
    const keyArray = Array.isArray(keys) ? keys : [keys];

    // Auto-open Control Mode if not connected
    if (!this.controlMode || this.currentSession !== session) {
      await this.openSession(session);
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
    const target = `${session}:${window}`;
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
   * Wait for Claude session to be ready for input.
   *
   * Detection is observation-based, NOT regex-on-pane: we wait for the
   * worktree's `.afk/claude-status.json` to be written by the statusline
   * tee (configured via `configureStatusline()`). Claude Code's statusline
   * is invoked on every turn — its first invocation means the TUI is up
   * and processing input.
   *
   * Avoids: pane capture + glyph matching (breaks on theme/font changes).
   */
  async waitForPrompt(worktreeDir: string, timeout: number = 30000): Promise<boolean> {
    const { promises: fs } = await import('fs');
    const { join } = await import('path');
    const statusPath = join(worktreeDir, '.afk', 'claude-status.json');
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        await fs.access(statusPath);
        return true;
      } catch {
        await this.sleep(500);
      }
    }
    return false;
  }

  /**
   * Send /goal command with text, followed by instructions to write signal.
   * @param signalType - The signal type to write on completion (default: 'goal_complete')
   */
  async sendGoal(worktreeDir: string, session: string, window: string, goalText: string, signalType: string = 'goal_complete'): Promise<void> {
    const hasPrompt = await this.waitForPrompt(worktreeDir);
    if (!hasPrompt) throw new Error('Timeout waiting for claude prompt');

    // Type /goal command with the goal text. The text is submitted as a single line
    // (no embedded newlines which would cause premature submission in the TUI).
    await this.exec(['send-keys', '-t', `${session}:${window}`, '--', `/goal ${goalText}`]);
    await this.sleep(500);

    // After the agent completes the goal, it reports completion via
    // ExecutionResult (structured output).
    //
    // Double-tap C-m to submit: the first Enter can be lost if the TUI is
    // mid-redraw on a long wrapped line; the second is a harmless no-op.
    await this.exec(['send-keys', '-t', `${session}:${window}`, 'C-m']);
    await this.sleep(300);
    await this.exec(['send-keys', '-t', `${session}:${window}`, 'C-m']);
  }

  /**
   * Wait for signal file to appear.
   * Uses Control Mode output events when connected, falls back to polling.
   */
  async waitForSignal(
    session: string,
    window: string,
    signalType: Signal['type'],
    worktreeDir: string,
    timeout: number = 300000
  ): Promise<Signal | null> {
    // Try Control Mode first if connected to this session
    if (this.controlMode && this.currentSession === session) {
      return new Promise<Signal | null>((resolve) => {
        const outputHandler = (_pane: string, text: string) => {
          // When we see the signal file written, resolve
          const signal = readSignalSync(worktreeDir);
          if (signal && signal.type === signalType) {
            this.controlMode!.offOutput(outputHandler);
            resolve(signal);
          }
        };
        this.controlMode!.onOutput(outputHandler);

        // Timeout fallback
        const timer = setTimeout(() => {
          this.controlMode!.offOutput(outputHandler);
          resolve(null);
        }, timeout);
      });
    }

    // Fallback: filesystem polling
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const signal = await readSignal(worktreeDir);
      if (signal && signal.type === signalType) return signal;
      await this.sleep(2000);
    }
    return null;
  }

  /**
   * Wait for ANY of several signal types
   */
  async waitForAnySignal(
    session: string,
    window: string,
    signalTypes: Signal['type'][],
    worktreeDir: string,
    timeout: number = TIMEOUTS.TMUX_SESSION_TIMEOUT
  ): Promise<Signal | null> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const signal = await readSignal(worktreeDir);
      if (signal && signalTypes.includes(signal.type)) return signal;
      await this.sleep(2000);
    }
    return null;
  }

  /**
   * Wait for tmux session to exit
   */
  async waitSessionExit(session: string, timeout: number = TIMEOUTS.TMUX_SESSION_TIMEOUT): Promise<number> {
    return new Promise((resolve, reject) => {
      const proc = spawn('bash', ['-c', `
        while tmux has-session -t "${session}" 2>/dev/null; do sleep 2; done
        echo "SESSION_EXITED"
      `], { stdio: 'pipe' });
      let stdout = '';
      proc.stdout?.on('data', (data) => { stdout += data.toString(); });
      const timer = setTimeout(() => { proc.kill(); reject(new Error(`timeout after ${timeout}ms`)); }, timeout);
      proc.on('close', (code) => { clearTimeout(timer); resolve(code ?? 0); });
      proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
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
