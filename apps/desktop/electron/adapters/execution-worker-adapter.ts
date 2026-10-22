import { spawn } from 'node:child_process';
import type { ExecuteWorkItemInput } from '@afk/runtime/execution';

export function createExecutionWorker(entry: string, executable = process.execPath, launch = spawn) {
  return (input: ExecuteWorkItemInput, workspace: string) => launch(executable, [entry, JSON.stringify(input)], {
    cwd: workspace,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PWD: workspace },
  });
}
