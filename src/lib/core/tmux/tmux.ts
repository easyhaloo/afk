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
   * Create new tmux session
   */
  async createSession(name: string, dir: string, command: string = 'claude'): Promise<TmuxSession> {
    const window = 'main';
    await this.exec([
      'new-session',
      '-d',
      '-s', name,
      '-n', window,
      '-c', dir,
      command,
    ]);
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
   * Send /goal command with text
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
   * Send /resume with AC check
   */
  async sendResumeWithAC(session: string, window: string, acItems: string[]): Promise<void> {
    await this.sendKeys(session, window, '/resume');
    await this.sleep(300);
    await this.sendKeys(session, window, '请运行以下验收条件（AC）检查，完成后创建信号文件：');
    await this.sendKeys(session, window, 'cat > .afk-signal.json <<EOF');
    await this.sendKeys(session, window, `{"type":"ac_result","result":"PASS或FAIL","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","summary":"<检查总结>"}`);
    await this.sendKeys(session, window, 'EOF');
    for (const item of acItems) {
      await this.sendKeys(session, window, item);
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
