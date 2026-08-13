import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const AFK_HOME = path.join(os.homedir(), '.afk');
export const LOOP_PID_FILE = path.join(AFK_HOME, 'loop.pid');

export function ensurePidDirectory(): void {
  fs.mkdirSync(path.dirname(LOOP_PID_FILE), { recursive: true });
}

export function readPid(): number | null {
  try {
    const value = Number(fs.readFileSync(LOOP_PID_FILE, 'utf-8').trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function removePidFile(): void {
  try {
    fs.unlinkSync(LOOP_PID_FILE);
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
