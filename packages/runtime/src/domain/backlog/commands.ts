import type {
  BacklogCreateInput,
  BacklogListOptions,
  BacklogManagementProvider,
  BacklogItem,
  QABacklogProvider,
} from './index.js';

export type { BacklogManagementProvider } from './index.js';

export async function listBacklogs(provider: BacklogManagementProvider, options: BacklogListOptions): Promise<BacklogItem[]> {
  return provider.list(options);
}

export async function showBacklog(provider: BacklogManagementProvider, id: string): Promise<BacklogItem> {
  return provider.get(id);
}

export async function adoptBacklog(provider: BacklogManagementProvider, id: string): Promise<BacklogItem> {
  if (!provider.adopt) throw new Error('backlog provider does not support explicit issue adoption');
  return provider.adopt(id);
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
  // A closed issue derives as done even when its label still says "merge
  // pending", so the label decides whether there is anything left to do.
  const labeledState = item.labeledState ?? item.state;
  if (labeledState === 'done') return item;
  if (labeledState !== 'merge_ready' || item.executionMode !== 'hitl') {
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

export interface BacklogMergeReconciliation {
  /** True when this call moved the backlog to done. */
  reconciled: boolean;
  /** Why the backlog was left alone, or what completed it. */
  reason: string;
  item: BacklogItem;
}

/**
 * Bring a backlog item in line with a change that is already merged.
 *
 * confirmBacklogMerge merges the change itself, so it stays a human action.
 * This function never merges: it only reports the provider state the human
 * merge already produced. A backlog whose change is still open is left
 * untouched, so the merge gate keeps its meaning.
 */
export async function reconcileMergedBacklog(
  provider: QABacklogProvider,
  changes: BacklogChangeProvider,
  id: string,
  expectedTargetBranch: string,
): Promise<BacklogMergeReconciliation> {
  const item = await provider.get(id);
  if (item.parentId) {
    return { reconciled: false, reason: `backlog ${id} is not a root backlog`, item };
  }
  // A closed issue derives as done even when its label still says "merge
  // pending" — that stale label is exactly what this reconciles.
  const labeledState = item.labeledState ?? item.state;
  if (labeledState === 'done') {
    return { reconciled: false, reason: `backlog ${id} is already done`, item };
  }
  if (labeledState !== 'merge_ready' || item.executionMode !== 'hitl') {
    return { reconciled: false, reason: `backlog ${id} is ${labeledState}/${item.executionMode}; only merge_ready + hitl can be reconciled`, item };
  }
  const change = await changes.findForBacklog(item);
  if (!change) {
    return { reconciled: false, reason: `backlog ${id} has no associated change`, item };
  }
  const verificationBranch = `${item.branchName}-qa`;
  if (change.sourceBranch !== verificationBranch && change.sourceBranch !== item.branchName) {
    return { reconciled: false, reason: `associated change ${change.id} uses source branch ${change.sourceBranch}`, item };
  }
  if (change.targetBranch !== expectedTargetBranch) {
    return { reconciled: false, reason: `associated change ${change.id} targets ${change.targetBranch}, not ${expectedTargetBranch}`, item };
  }
  if (change.state !== 'merged') {
    return { reconciled: false, reason: `associated change ${change.id} is ${change.state}; the human merge gate is still open`, item };
  }
  await provider.transition(id, 'done', { changeId: change.id });
  return { reconciled: true, reason: `associated change ${change.id} is merged`, item: await provider.get(id) };
}

function requiredReason(reason: string): string {
  const value = reason.trim();
  if (!value) throw new Error('reason must not be empty');
  return value;
}
