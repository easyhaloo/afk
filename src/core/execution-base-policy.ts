import type { WorkItem } from './model';

export interface ExecutionBaseCandidate {
  id: string;
  state: WorkItem['state'];
  branchName?: string;
}

export interface ExecutionBaseResolution {
  branch: string;
  source: 'target' | 'explicit_unmerged_base' | 'explicit_completed_base';
  baseWorkItemId?: string;
}

/**
 * Resolves only the Git execution baseline. Organizational parent and scheduling
 * dependencies are deliberately ignored: neither is a branch-selection signal.
 */
export function resolveExecutionBase(
  item: Pick<WorkItem, 'lineage'>,
  lookup: (id: string) => ExecutionBaseCandidate | undefined,
  targetBranch: string,
): ExecutionBaseResolution {
  const baseWorkItemId = item.lineage.baseWorkItemId;
  if (!baseWorkItemId) return { branch: targetBranch, source: 'target' };

  const base = lookup(baseWorkItemId);
  if (!base || base.state === 'done' || base.state === 'cancelled' || !base.branchName) {
    return { branch: targetBranch, source: 'explicit_completed_base', baseWorkItemId };
  }
  return { branch: base.branchName, source: 'explicit_unmerged_base', baseWorkItemId };
}
