import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * AFK workspace resolution.
 *
 * The workspace is the directory that holds the repositories a user works
 * with. `AFK_WORKSPACE` names it; the desktop client sets it from its
 * workspace preference and passes it to every AFK process it starts. Without
 * it, AFK's own home directory is the workspace.
 *
 * Workspace-local state lives in `<workspace>/.afk/`, which is the convention
 * the desktop client already uses for runs and execution manifests. The home
 * directory is already that directory, so the default needs no extra path.
 */

/** The workspace root directory. */
export function resolveWorkspaceRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AFK_WORKSPACE?.trim();
  return configured ? resolve(configured) : join(homedir(), '.afk');
}

/** The directory AFK keeps workspace-local state in. */
export function workspaceStateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AFK_WORKSPACE?.trim();
  return configured ? join(resolve(configured), '.afk') : join(homedir(), '.afk');
}
