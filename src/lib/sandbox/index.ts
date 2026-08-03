/**
 * Sandbox — unified execution environment abstraction.
 *
 * Public surface:
 * - Types (SandboxProvider, Sandbox, AgentExecution, ExecutionResult, etc.)
 * - Provider implementations (local, docker, podman)
 * - Factory: createSandboxProvider()
 *
 * Import from here rather than from individual sub-modules.
 */
export * from './types';
export * from './legacy-compat';
export * from './providers';

import { LocalSandboxProvider } from './providers/local';
import { ContainerSandboxProvider, DockerContainerProvider, PodmanContainerProvider } from './providers';
import type { SandboxProviderName } from './types';
import type { WorktreeManager } from '../core/git/worktree';

/**
 * Factory: resolve a SandboxProviderName to a SandboxProvider instance.
 * All provider-internal assembly is encapsulated here — callers only get
 * the ready-to-use provider.
 */
export function createSandboxProvider(
  name: SandboxProviderName,
  deps: { worktreeManager: WorktreeManager },
): import('./types').SandboxProvider {
  switch (name) {
    case 'local':
      return new LocalSandboxProvider(deps.worktreeManager);
    case 'docker':
      return new ContainerSandboxProvider({ provider: new DockerContainerProvider() });
    case 'podman':
      return new ContainerSandboxProvider({ provider: new PodmanContainerProvider() });
  }
}
