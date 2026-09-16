import { describe, expect, it, vi } from 'vitest';
import { resolveExecutionBase, type ExecutionBaseCandidate, type WorkItem } from './index';

const item = (lineage: Partial<WorkItem['lineage']>): Pick<WorkItem, 'lineage'> => ({
  lineage: { dependsOn: [], ...lineage },
});

describe('resolveExecutionBase', () => {
  it('uses the target branch for an organizational parent and dependencies alone', () => {
    const lookup = vi.fn((): ExecutionBaseCandidate => ({
      id: 'group-1',
      state: 'implementing',
      branchName: 'afk/backlog-group-1',
    }));
    const result = resolveExecutionBase(
      item({ parentId: 'group-1', dependsOn: ['task-1'] }),
      lookup,
      'main',
    );
    expect(result).toEqual({ branch: 'main', source: 'target' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('uses an explicitly selected unmerged base branch', () => {
    const lookup = vi.fn((): ExecutionBaseCandidate => ({
      id: 'task-1',
      state: 'verifying',
      branchName: 'afk/backlog-task-1',
    }));
    const result = resolveExecutionBase(
      item({ baseWorkItemId: 'task-1' }),
      lookup,
      'main',
    );
    expect(result).toEqual({
      branch: 'afk/backlog-task-1',
      source: 'explicit_unmerged_base',
      baseWorkItemId: 'task-1',
    });
    expect(lookup).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledWith('task-1');
  });

  it('returns to target when the explicit base was completed or cannot be resolved', () => {
    const complete = resolveExecutionBase(
      item({ baseWorkItemId: 'task-1' }),
      () => ({ id: 'task-1', state: 'done', branchName: 'afk/backlog-task-1' }),
      'main',
    );
    const missing = resolveExecutionBase(item({ baseWorkItemId: 'missing' }), () => undefined, 'main');

    expect(complete).toMatchObject({ branch: 'main', source: 'explicit_completed_base' });
    expect(missing).toMatchObject({ branch: 'main', source: 'explicit_completed_base' });
  });
});
