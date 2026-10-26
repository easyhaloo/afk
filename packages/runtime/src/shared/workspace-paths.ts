import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function resolveWorkspaceRoot(_env: NodeJS.ProcessEnv = process.env): string {
  return join(homedir(), '.loop-workspace');
}

export function workspaceStateDirectory(_env: NodeJS.ProcessEnv = process.env): string {
  return join(homedir(), '.afk');
}

export function workspaceDataDirectory(workspace: string): string {
  const key = createHash('sha256').update(resolve(workspace)).digest('hex');
  return join(workspaceStateDirectory(), 'workspaces', key);
}
