import { spawn } from 'child_process';
import type { ChildProcess, SpawnOptions } from 'child_process';

/**
 * Detached spawn that works on both Linux and macOS.
 * `detached: true` + `stdio: 'ignore'` detaches from TTY on both platforms.
 * Returns the child so the caller can kill it (whole process group) later.
 */
function spawnDetached(file: string, args: string[], opts: SpawnOptions): ChildProcess {
  const child = spawn(file, args, { ...opts, stdio: 'ignore', detached: true } as SpawnOptions);
  child.unref();
  return child;
}

/**
 * Hard-timeout watchdog: a detached process-group that fires after hardTimeoutMs
 * and kills the tmux session.
 *
 * The WorkflowRunner arms one per phase / generation. The runner's
 * waitForResult() polls the tmux session state directly, so the watchdog
 * only needs to kill the session — it does not need to write any signal file.
 *
 * `disarm()` kills the whole process group (negative pid targets the sleep
 * child too); a stale armed watchdog would otherwise fire later and
 * unexpectedly kill a later session.
 */
export class Watchdog {
  private child: ChildProcess | null = null;

  constructor(private readonly logDir: string) {}

  /**
   * Arm the watchdog: after hardTimeoutMs, write a timeout signal then kill
   * the session. Re-arming replaces any previously armed watchdog.
   */
  arm(session: string, hardTimeoutMs: number, iid: number, worktreePath: string): void {
    this.disarm();
    const shellCmd =
      `sleep ${hardTimeoutMs / 1000} && ` +
      `tmux kill-session -t "${session}" 2>/dev/null || true; ` +
      `echo "WATCHDOG:${iid}:${session}:${hardTimeoutMs}" >> "${this.logDir}/watchdog.log"`;
    this.child = spawnDetached('bash', ['-c', shellCmd], { cwd: process.cwd() });
  }

  /**
   * Disarm: kill the process group so the sleep child dies with it. Idempotent
   * (no-op when nothing is armed). Safe to call from finally blocks.
   */
  disarm(): void {
    if (this.child?.pid) {
      try {
        process.kill(-this.child.pid, 'SIGTERM');
      } catch { /* already exited */ }
      this.child = null;
    }
  }

  /** True if a watchdog is currently armed. */
  isArmed(): boolean {
    return this.child !== null && !this.child.killed && this.child.exitCode === null;
  }
}

/**
 * Factory: create a Watchdog instance.
 * Tests may inject a fake via RunnerDependencies.watchdog instead.
 */
export function createWatchdog(logDir: string): Watchdog {
  return new Watchdog(logDir);
}
