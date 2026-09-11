import { describe, expect, it } from 'vitest';
import { resolveExecutionBase, type WorkItem } from './index';

const item = (lineage: Partial<WorkItem['lineage']>): Pick<WorkItem, 'lineage'> => ({
  lineage: { dependsOn: [], ...lineage },
});

describe('resolveExecutionBase', () => {
  it('uses the target branch for an organizational parent and dependencies alone', () => {
    const result = resolveExecutionBase(
      item({ parentId: 'group-1', dependsOn: ['task-1'] }),
      () => ({ id: 'group-1', state: 'implementing', branchName: 'afk/backlog-group-1' }),
      'main',
    );
    expect(result).toEqual({ branch: 'main', source: 'target' });
  });

  it('uses an explicitly selected unmerged base branch', () => {
    const result = resolveExecutionBase(
      item({ baseWorkItemId: 'task-1' }),
      () => ({ id: 'task-1', state: 'verification', branchName: 'afk/backlog-task-1' }),
      'main',
    );
    expect(result).toEqual({
      branch: 'afk/backlog-task-1',
      source: 'explicit_unmerged_base',
      baseWorkItemId: 'task-1',
    });
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
