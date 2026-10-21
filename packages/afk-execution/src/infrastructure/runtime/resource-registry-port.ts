import { AFK_RUNTIME_RESOURCES_FILE } from '@afk/core';
import type { ResourceRegistryPort } from '@afk/application';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readActiveAfkResources, readRunAfkResources } from './resource-registry.js';

/**
 * Where the registry keeps its table, when nothing else says.
 *
 * The registry is the runtime's own record of what it handed out, and the
 * file it lives in is the registry's business - a reader asks the registry
 * what is in it rather than opening the file itself.
 */
export function defaultResourceRegistryPath(): string {
  return join(homedir(), AFK_RUNTIME_RESOURCES_FILE);
}

/**
 * The registered resources, reached through the port.
 *
 * The path is the registry's own, so a reader cannot point the registry at
 * a table that is not the one the runtime wrote to.
 */
export function createResourceRegistryPort(
  databasePath: string = defaultResourceRegistryPath(),
): ResourceRegistryPort {
  return {
    readActive: (workspaces) => readActiveAfkResources(databasePath, workspaces),
    readRun: (runId) => readRunAfkResources(databasePath, runId),
  };
}

export const resourceRegistryPort: ResourceRegistryPort = createResourceRegistryPort();
