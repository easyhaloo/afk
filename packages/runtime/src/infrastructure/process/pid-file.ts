import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const AFK_HOME = path.join(os.homedir(), '.afk');
export const LOOP_PID_FILE = path.join(AFK_HOME, 'loop.pid');

/**
 * Where the loop records its process id.
 *
 * The default keeps one loop per machine. An explicit path lets several
 * manifest-bound loops run side by side, each on its own work item.
 */
export function loopPidFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AFK_LOOP_PID_FILE?.trim();
  return configured ? path.resolve(configured) : LOOP_PID_FILE;
}

/** Where the loop writes its status snapshot. */
export function loopStatusFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AFK_LOOP_STATUS_FILE?.trim();
  return configured ? path.resolve(configured) : path.join(AFK_HOME, 'loop-status.json');
}

export function ensurePidDirectory(): void {
  fs.mkdirSync(path.dirname(loopPidFilePath()), { recursive: true });
}

export function readPid(): number | null {
  try {
    const value = Number(fs.readFileSync(loopPidFilePath(), 'utf-8').trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function removePidFile(): void {
  try {
    fs.unlinkSync(loopPidFilePath());
  } catch {
    // A missing pid file is already the desired state.
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not owned by this user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
