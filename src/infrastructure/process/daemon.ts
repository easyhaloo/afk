import { spawn } from 'child_process';

export interface DaemonSpawnOptions {
  executable: string;
  script: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export function spawnDetached(options: DaemonSpawnOptions): ChildProcess {
  const child = spawn(options.executable, [options.script, ...options.args], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: options.env,
  });
  child.unref();
  return child;
}

export async function waitForProcessPid(
  readPid: () => number | null,
  isAlive: (pid: number) => boolean,
  timeoutMs: number,
  pollIntervalMs = 50,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = readPid();
    if (pid !== null && isAlive(pid)) return pid;
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  return null;
}

type ChildProcess = ReturnType<typeof spawn>;
