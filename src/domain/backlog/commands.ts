import type {
  BacklogCreateInput,
  BacklogListOptions,
  BacklogManagementProvider,
  BacklogItem,
  QABacklogProvider,
} from './index';

export type { BacklogManagementProvider } from './index';

export async function listBacklogs(provider: BacklogManagementProvider, options: BacklogListOptions): Promise<BacklogItem[]> {
  return provider.list(options);
}

export async function showBacklog(provider: BacklogManagementProvider, id: string): Promise<BacklogItem> {
  return provider.get(id);
}

export async function createBacklog(provider: BacklogManagementProvider, input: BacklogCreateInput): Promise<BacklogItem> {
  return provider.create(input);
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

export interface BacklogChangeProvider {
  findForBacklog(backlog: BacklogItem): Promise<{ id: string; state: 'open' | 'merged' | 'closed'; sourceBranch: string; targetBranch: string; mergeable?: boolean } | null>;
  merge(id: string): Promise<void>;
  get(id: string): Promise<{ id: string; state: 'open' | 'merged' | 'closed'; sourceBranch: string; targetBranch: string; mergeable?: boolean }>;
}

export async function interruptBacklog(
  provider: QABacklogProvider,
  id: string,
  reason: string,
): Promise<BacklogItem> {
  const summary = requiredReason(reason);
  const item = await provider.get(id);
  if (item.state === 'blocked' && item.executionMode === 'hitl') return item;
  if (item.state !== 'in_progress' && item.state !== 'verification') {
    throw new Error(`invalid lifecycle transition: cannot interrupt backlog ${id} from ${item.state}`);
  }
  await provider.transition(id, 'blocked', { reason: summary });
  await provider.setExecutionMode(id, 'hitl');
  return provider.get(id);
}

export async function retryBacklog(
  provider: QABacklogProvider,
  id: string,
  reason: string,
): Promise<BacklogItem> {
  const summary = requiredReason(reason);
  const item = await provider.get(id);
  if (item.state === 'rework' && item.executionMode === 'afk') return item;
  if (item.state !== 'blocked' || item.executionMode !== 'hitl') {
    throw new Error(`invalid lifecycle transition: retry requires blocked + hitl for backlog ${id}`);
  }
  await provider.createRework(id, {
    source: 'operator',
    summary,
    failedCriteria: [],
    requiredChecks: [],
  });
  return provider.get(id);
}

export async function confirmBacklogMerge(
  provider: QABacklogProvider,
  changes: BacklogChangeProvider,
  id: string,
  expectedTargetBranch: string,
): Promise<BacklogItem> {
  const item = await provider.get(id);
  if (item.parentId) throw new Error(`merge confirmation must be a root backlog: ${id}`);
  if (item.state === 'done') return item;
  if (item.state !== 'merge_ready' || item.executionMode !== 'hitl') {
    throw new Error(`invalid lifecycle transition: merge confirmation requires merge_ready + hitl for backlog ${id}`);
  }
  const change = await changes.findForBacklog(item);
  if (!change) throw new Error(`backlog ${id} must have an associated change`);
  const verificationBranch = `${item.branchName}-qa`;
  if (change.sourceBranch !== verificationBranch && change.sourceBranch !== item.branchName) {
    throw new Error(`associated change ${change.id} must use source branch ${verificationBranch} or ${item.branchName}`);
  }
  if (change.targetBranch !== expectedTargetBranch) throw new Error(`associated change ${change.id} must target ${expectedTargetBranch}`);
  if (change.state === 'closed') throw new Error(`associated change ${change.id} must be open or merged`);
  if (change.state === 'open' && change.mergeable === false) throw new Error(`associated change ${change.id} must be mergeable`);
  if (change.state === 'open') await changes.merge(change.id);
  const confirmed = await changes.get(change.id);
  if (confirmed.targetBranch !== expectedTargetBranch) throw new Error(`associated change ${change.id} target branch changed before confirmation`);
  if (confirmed.state !== 'merged') throw new Error(`associated change ${change.id} must be merged before backlog ${id} can complete`);
  await provider.transition(id, 'done', { changeId: change.id });
  return provider.get(id);
}

function requiredReason(reason: string): string {
  const value = reason.trim();
  if (!value) throw new Error('reason must not be empty');
  return value;
}
