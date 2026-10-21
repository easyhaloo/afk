import type { LoopProcessPort } from '@afk/application';
import { spawnDetached, waitForProcessPid } from './daemon.js';
import {
  LOOP_PID_FILE,
  ensurePidDirectory,
  isProcessAlive,
  readPid,
  removePidFile,
} from './pid-file.js';

/**
 * The loop daemon's process, reached through the port.
 *
 * The pid file is the runtime's own record of what it started, so where it
 * lives and what it holds are the runtime's business. A caller says
 * "start it" and "is it running", and never reads a pid file itself.
 */
export const loopProcessPort: LoopProcessPort = {
  pidFile: () => LOOP_PID_FILE,
  ensurePidDirectory,
  readPid,
  removePidFile,
  isAlive: isProcessAlive,
  spawnDaemon: options => spawnDetached({
    executable: options.executable,
    script: options.script,
    args: options.args,
    env: options.env as NodeJS.ProcessEnv,
  }).pid,
  waitForPid: timeoutMs => waitForProcessPid(readPid, isProcessAlive, timeoutMs),
  terminate: (pid, signal) => { process.kill(pid, signal); },
};
