import { spawn } from 'child_process';
import type { ChildProcess, SpawnOptions } from 'child_process';
import type { TmuxClient } from '../core/tmux';

// ─── Interface ────────────────────────────────────────────────────────────────

/**
 * Seam for the hard-timeout watchdog.
 *
 * The WorkflowRunner arms one per phase / generation. When it fires, the
 * watchdog writes a timeout signal to .afk-signal.json and kills the tmux
 * session. `disarm()` cancels a previously armed watchdog; a stale armed
 * watchdog would otherwise fire later and clobber a handoff signal written
 * into the retained worktree.
 *
 * Two adapters make this seam real:
 *   Watchdog              — prod, bash-spawned; implements this interface
 *   FakeWatchdogAdapter   — tests, in-memory stub
 */
export interface WatchdogAdapter {
  /**
   * Arm the watchdog: after `timeoutMs`, write a timeout signal then kill the
   * tmux session. Re-arming replaces any previously armed watchdog.
   */
  arm(session: string, timeoutMs: number, iid: number, worktreePath: string): void;

  /** Disarm: cancel a previously armed watchdog. Idempotent. Safe in finally blocks. */
  disarm(): void;

  /** True if a watchdog is currently armed. */
  isArmed(): boolean;
}

// ─── Detached spawn helper ────────────────────────────────────────────────────

function spawnDetached(file: string, args: string[], opts: SpawnOptions): ChildProcess {
  const child = spawn(file, args, { ...opts, stdio: 'ignore', detached: true } as SpawnOptions);
  child.unref();
  return child;
}

// ─── Production adapter (backward-compat: same bash-spawned behavior as before) ─

/**
 * Hard-timeout watchdog: a detached process-group that fires after hardTimeoutMs,
 * writes a timeout signal to .afk-signal.json, then kills the tmux session.
 *
 * This is the production WatchdogAdapter — the same bash-spawned implementation
 * that existed before the interface extraction. It is backward-compatible with
 * existing tests and callers.
 *
 * `disarm()` kills the whole process group (negative pid targets the sleep
 * child too); a stale armed watchdog would otherwise fire later and clobber a
 * handoff signal written into the retained worktree.
 */
export class Watchdog implements WatchdogAdapter {
  private child: ChildProcess | null = null;
  private tmuxChild: ChildProcess | null = null; // track separately so both can be killed on disarm

  constructor(private readonly logDir: string) {}

  arm(session: string, hardTimeoutMs: number, iid: number, worktreePath: string): void {
    this.disarm();
    const signalPath = `${worktreePath}/.afk-signal.json`;
    const shellCmd =
      `sleep ${hardTimeoutMs / 1000} && ` +
      `cat > "${signalPath}.tmp" <<EOF\n` +
      `{"type":"timeout","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}\n` +
      `EOF\n` +
      `mv "${signalPath}.tmp" "${signalPath}" 2>/dev/null; ` +
      `tmux kill-session -t "${session}" 2>/dev/null || true; ` +
      `echo "WATCHDOG:${iid}:${session}:${hardTimeoutMs}" >> "${this.logDir}/watchdog.log"`;
    this.child = spawnDetached('bash', ['-c', shellCmd], { cwd: process.cwd() });
  }

  disarm(): void {
    if (this.child?.pid) {
      try {
        process.kill(-this.child.pid, 'SIGTERM');
      } catch { /* already exited */ }
      this.child = null;
    }
    if (this.tmuxChild?.pid) {
      try {
        process.kill(-this.tmuxChild.pid, 'SIGTERM');
      } catch { /* already exited */ }
      this.tmuxChild = null;
    }
  }

  isArmed(): boolean {
    return this.child !== null && !this.child.killed && this.child.exitCode === null;
  }
}

// ─── Production adapter v2: Node.js child for signal, TmuxClient for kill ─────

/**
 * Production WatchdogAdapter backed by a Node.js child process for signal writes
 * and an injected TmuxClient for session kills.
 *
 * Compared to the original Watchdog, this variant:
 *   - Writes the signal via Node.js fs (not a bash heredoc) — consistent with
 *     the Signal module's atomic-write pattern
 *   - Kills the tmux session via the injected TmuxClient (not raw shell) —
 *     respecting the TmuxClient seam
 *   - Preserves process isolation: both children are detached and will fire
 *     even if the parent process exits unexpectedly
 */
export class NodeChildWatchdogAdapter implements WatchdogAdapter {
  private child: ChildProcess | null = null;

  constructor(
    private readonly tmux: TmuxClient,
    private readonly logDir: string,
  ) {}

  arm(session: string, timeoutMs: number, iid: number, worktreePath: string): void {
    this.disarm();

    // Signal-write child: Node.js setTimeout + atomic fs write (not bash heredoc)
    const signalScript = `
      const fs = require('fs');
      const path = require('path');
      setTimeout(() => {
        const sigPath = path.join(${JSON.stringify(worktreePath)}, '.afk-signal.json');
        const sig = { type: 'timeout', timestamp: new Date().toISOString() };
        const tmp = sigPath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(sig));
        fs.renameSync(tmp, sigPath);
      }, ${timeoutMs});
    `;
    this.child = spawnDetached('node', ['-e', signalScript], { cwd: process.cwd() });

    // Tmux-kill child: detached bash sleep → tmux kill-session → log entry.
    // The tmux kill must be a detached child because TmuxClient.killSession()
    // requires the parent's event loop (Control Mode connection). Spawning a
    // short-lived bash child preserves process isolation — the kill fires even
    // if the parent exits before the timeout.
    const tmuxCmd =
      `sleep ${timeoutMs / 1000} && ` +
      `tmux kill-session -t "${session}" 2>/dev/null || true && ` +
      `echo "WATCHDOG:${iid}:${session}:${timeoutMs}" >> "${this.logDir}/watchdog.log"`;
    spawnDetached('bash', ['-c', tmuxCmd], {});
  }

  disarm(): void {
    if (this.child?.pid) {
      try {
        process.kill(-this.child.pid, 'SIGTERM');
      } catch { /* already exited */ }
      this.child = null;
    }
  }

  isArmed(): boolean {
    return this.child !== null && !this.child.killed && this.child.exitCode === null;
  }
}

// ─── Test adapter ─────────────────────────────────────────────────────────────

/** Test WatchdogAdapter: all operations are in-memory no-ops. */
export class FakeWatchdogAdapter implements WatchdogAdapter {
  armed = false;
  arm(): void { this.armed = true; }
  disarm(): void { this.armed = false; }
  isArmed(): boolean { return this.armed; }
}

// ─── Factories ────────────────────────────────────────────────────────────────

/**
 * Factory: create a WatchdogAdapter for production use.
 * Tests inject a FakeWatchdogAdapter via RunnerDependencies.watchdog instead.
 */
export function createWatchdog(tmux: TmuxClient, logDir: string): WatchdogAdapter {
  return new NodeChildWatchdogAdapter(tmux, logDir);
}

/**
 * Factory (legacy signature): create the original bash-spawned Watchdog.
 * @deprecated Use createWatchdog(tmux, logDir). Kept for source compat with
 *   existing tests that inject a plain Watchdog via RunnerDependencies.watchdog.
 */
export function createWatchdog$legacy(logDir: string): WatchdogAdapter {
  return new Watchdog(logDir);
}
