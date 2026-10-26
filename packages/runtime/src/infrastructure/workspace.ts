import { join, resolve } from 'node:path';
import { parseWorkItemId } from '../domain/work-item/identity.js';
import { resolveWorkspaceRoot, workspaceDataDirectory } from '../shared/workspace-paths.js';
export { resolveWorkspaceRoot, workspaceStateDirectory, workspaceDataDirectory } from '../shared/workspace-paths.js';

export function executionWorkspacePath(workItemId: string, baseDirectory = resolveWorkspaceRoot()): string {
  if (workItemId.includes(':') || workItemId.includes('#')) parseWorkItemId(workItemId);
  else if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(workItemId) || workItemId.includes('..')) {
    throw new Error('work item ID is invalid');
  }
  const segments = workItemId.split(/[:/#]+/);
  if (segments.some(segment => !/^[A-Za-z0-9._-]+$/.test(segment) || segment === '.' || segment === '..')) {
    throw new Error('work item ID produces an invalid workspace directory');
  }
  return join(resolve(baseDirectory), ...segments);
}

export function executionManifestPath(workItemId: string): string {
  return join(workspaceDataDirectory(executionWorkspacePath(workItemId)), 'execution-manifest.json');
}
