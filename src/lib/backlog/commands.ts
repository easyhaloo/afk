import type {
  BacklogListOptions,
  BacklogManagementProvider,
  BacklogExecutionMode,
  BacklogItem,
  BacklogState,
} from '../core/backlog';

export type { BacklogManagementProvider } from '../core/backlog';

export async function listBacklogs(provider: BacklogManagementProvider, options: BacklogListOptions): Promise<BacklogItem[]> {
  return provider.list(options);
}

export async function showBacklog(provider: BacklogManagementProvider, id: string): Promise<BacklogItem> {
  return provider.get(id);
}

export async function initializeBacklog(provider: BacklogManagementProvider): Promise<void> {
  await provider.initialize();
}

export async function addBacklogTag(provider: BacklogManagementProvider, id: string, tag: string): Promise<void> {
  await provider.addTag(id, tag);
}

export async function removeBacklogTag(provider: BacklogManagementProvider, id: string, tag: string): Promise<void> {
  await provider.removeTag(id, tag);
}
