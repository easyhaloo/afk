import { spawn } from 'child_process';
import { Signal } from '../../schemas';
import { readSignal } from '../io/signal';
import { TIMEOUTS } from '../../constants';

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
 * Tmux client wrapper for session management
 */
export class TmuxClient {
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
   * Send keys to session
   */
  async sendKeys(session: string, window: string, keys: string | string[]): Promise<void> {
    const target = `${session}:${window}`;
    const keyArray = Array.isArray(keys) ? keys : [keys];
    for (const key of keyArray) {
      await this.exec(['send-keys', '-t', target, '--', key]);
      await this.exec(['send-keys', '-t', target, 'C-m']);
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
   * Send /goal command with text, followed by instructions to write goal_complete signal.
   */
  async sendGoal(worktreeDir: string, session: string, window: string, goalText: string): Promise<void> {
    const hasPrompt = await this.waitForPrompt(worktreeDir);
    if (!hasPrompt) throw new Error('Timeout waiting for claude prompt');
    await this.exec(['send-keys', '-t', `${session}:${window}`, '--', '/goal']);
    await this.exec(['send-keys', '-t', `${session}:${window}`, 'Space']);
    await this.sleep(300);
    const lines = goalText.split('\n');
    for (const line of lines) {
      await this.exec(['send-keys', '-t', `${session}:${window}`, '--', line]);
      await this.exec(['send-keys', '-t', `${session}:${window}`, 'C-m']);
      await this.sleep(100);
    }
    // Tell agent to commit changes, then write goal_complete signal when done.
    await this.exec(['send-keys', '-t', `${session}:${window}`, 'C-m']);
    await this.sleep(200);
    const timestamp = new Date().toISOString();
    await this.exec(['send-keys', '-t', `${session}:${window}`, '--', '完成后请先提交你的更改（git add -A && git commit -m "resolve issue"），然后创建完成信号：cat > .afk-signal.json <<EOF']);
    await this.sleep(100);
    await this.exec(['send-keys', '-t', `${session}:${window}`, '--', `{"type":"goal_complete","timestamp":"${timestamp}","summary":"<完成总结>"}`]);
    await this.sleep(100);
    await this.exec(['send-keys', '-t', `${session}:${window}`, '--', 'EOF']);
    await this.sleep(500);
    // Submit the composed /goal input. Double-tap C-m: the first Enter can be
    // lost if the TUI is mid-redraw on a long wrapped line; the second is a
    // harmless no-op if the first already submitted.
    await this.exec(['send-keys', '-t', `${session}:${window}`, 'C-m']);
    await this.sleep(300);
    await this.exec(['send-keys', '-t', `${session}:${window}`, 'C-m']);
  }

  /**
   * Wait for signal file to appear
   */
  async waitForSignal(
    session: string,
    window: string,
    signalType: Signal['type'],
    worktreeDir: string,
    timeout: number = 300000
  ): Promise<Signal | null> {
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

  /**
   * Send /resume with AC check.
   *
   * Receives structured AC items; sends both human-readable AC text and
   * (when present) the machine-checkable command so the agent can run it
   * and capture evidence rather than self-reporting.
   */
  async sendResumeWithAC(
    session: string,
    window: string,
    acItems: Array<{ index: number; text: string; evidenceType?: string; checkCommand?: string }>,
  ): Promise<void> {
    // Agent is idle at the prompt after writing goal_complete. Send the AC
    // check request directly. Do NOT use /resume - in Claude Code it opens a
    // session-picker UI, which swallows all subsequent input.
    await this.sendKeys(session, window, '请运行以下验收条件（AC）检查。每条 AC 都附有可执行命令，运行命令并把输出写入证据：');
    const timestamp = new Date().toISOString();
    await this.sendKeys(session, window, `完成后创建信号 cat > .afk-signal.json 写入：`);
    await this.sendKeys(session, window, `{"type":"ac_result","timestamp":"${timestamp}","summary":"<检查总结>"}`);
    for (const item of acItems) {
      const header = item.evidenceType && item.evidenceType !== 'none'
        ? `AC ${item.index} [${item.evidenceType}]: ${item.text}`
        : `AC ${item.index}: ${item.text}`;
      await this.sendKeys(session, window, header);
      if (item.checkCommand) {
        await this.sendKeys(session, window, `  $ ${item.checkCommand}`);
      }
      await this.sleep(100);
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
