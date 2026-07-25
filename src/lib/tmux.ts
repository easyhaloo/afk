import { spawn } from 'child_process';
import { Signal } from './schemas.js';
import { readSignal } from './io.js';

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
  async capturePane(
    session: string,
    window: string,
    options: TmuxCaptureOptions = {}
  ): Promise<string> {
    const { lines = 50, history = 100 } = options;
    const target = `${session}:${window}`;

    try {
      const output = await this.exec([
        'capture-pane',
        '-t', target,
        '-p',
        '-S', `-${history}`,
      ]);

      // Get last N lines
      const allLines = output.split('\n');
      return allLines.slice(-lines).join('\n');
    } catch {
      return '(capture failed)';
    }
  }

  /**
   * Wait for prompt (❯) to appear
   */
  async waitForPrompt(
    session: string,
    window: string,
    timeout: number = 30000
  ): Promise<boolean> {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const content = await this.capturePane(session, window, { lines: 5, history: 5 });
      if (content.includes('❯')) {
        return true;
      }
      await this.sleep(1000);
    }

    return false;
  }

  /**
   * Send /goal command with text
   */
  async sendGoal(session: string, window: string, goalText: string): Promise<void> {
    // Wait for prompt first
    const hasPrompt = await this.waitForPrompt(session, window);
    if (!hasPrompt) {
      throw new Error('Timeout waiting for claude prompt');
    }

    // Send /goal command
    await this.exec(['send-keys', '-t', `${session}:${window}`, '--', '/goal']);
    await this.exec(['send-keys', '-t', `${session}:${window}`, 'Space']);
    await this.sleep(300);

    // Send goal text line by line
    const lines = goalText.split('\n');
    for (const line of lines) {
      await this.exec(['send-keys', '-t', `${session}:${window}`, '--', line]);
      await this.exec(['send-keys', '-t', `${session}:${window}`, 'C-m']);
      await this.sleep(100);
    }
  }

  /**
   * Wait for signal file to appear (polls signal file + pane output)
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
      // Check signal file first
      const signal = await readSignal(worktreeDir);
      if (signal && signal.type === signalType) {
        return signal;
      }

      // Fallback: check pane output for legacy markers
      const content = await this.capturePane(session, window, { lines: 50, history: 100 });

      if (signalType === 'goal_complete' && content.includes('GOAL_COMPLETE')) {
        return {
          type: 'goal_complete',
          timestamp: new Date().toISOString(),
          summary: '(legacy marker detected)',
        };
      }

      if (signalType === 'ac_result') {
        if (content.includes('AC_RESULT: PASS')) {
          return {
            type: 'ac_result',
            timestamp: new Date().toISOString(),
            result: 'PASS',
            summary: '(legacy marker detected)',
          };
        }
        if (content.includes('AC_RESULT: FAIL')) {
          return {
            type: 'ac_result',
            timestamp: new Date().toISOString(),
            result: 'FAIL',
            summary: '(legacy marker detected)',
          };
        }
      }

      await this.sleep(2000);
    }

    return null;
  }

  /**
   * Execute tmux command
   */
  private async exec(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('tmux', args, { stdio: 'pipe' });
      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`tmux command failed: ${stderr || stdout}`));
        }
      });

      proc.on('error', reject);
    });
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
