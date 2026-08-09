import { describe, expect, it } from 'vitest';
import type { Task } from '../../../types/board';
import { getActivityLimit, getTaskPhaseLabel, getTaskProgress, getTaskQueue, getTaskSelectionIndex, truncateTaskText } from './model';

function task(overrides: Partial<Task> = {}): Task {
  return {
    iid: '42',
    runId: 'run-42',
    title: 'Add search mode',
    phase: 'implementing',
    executionMode: 'batch',
    sandboxProvider: 'local',
    agentProvider: 'claude-code',
    status: 'active',
    heartbeatAt: new Date('2026-08-09T10:00:00.000Z'),
    ...overrides,
  };
}

describe('task cockpit model', () => {
  it('orders tasks while retaining the focused run for the queue projection', () => {
    const queue = getTaskQueue([
      task({ runId: 'stale', iid: '40', status: 'stale', heartbeatAt: new Date('2026-08-09T09:00:00.000Z') }),
      task({ runId: 'focused', iid: '41', heartbeatAt: new Date('2026-08-09T10:02:00.000Z') }),
      task({ runId: 'active', iid: '43', heartbeatAt: new Date('2026-08-09T10:01:00.000Z') }),
    ]);

    expect(queue.map(item => item.runId)).toEqual(['focused', 'active', 'stale']);
  });

  it('chooses an activity budget from terminal width', () => {
    expect(getActivityLimit(79)).toBe(2);
    expect(getActivityLimit(100)).toBe(4);
    expect(getActivityLimit(120)).toBe(Number.POSITIVE_INFINITY);
  });

  it('normalizes phase and percentage context for the focused task', () => {
    expect(getTaskPhaseLabel(task({ phase: 'implementing' }))).toBe('processing');
    expect(getTaskPhaseLabel(task({ phase: 'verifying' }))).toBe('verification');
    expect(getTaskProgress(task({ progress: '64%' }))).toBe(64);
    expect(getTaskProgress(task({ progress: 'unknown' }))).toBe(0);
    expect(getTaskProgress(task({ progress: '125%' }))).toBe(100);
  });

  it('truncates titles by visual width', () => {
    expect(truncateTaskText('Add the long search workflow', 12)).toBe('Add the lo…');
    expect(truncateTaskText('搜索模式', 6)).toBe('搜索…');
  });

  it('keeps the selected run focused after runtime task ordering changes', () => {
    const tasks = [task({ runId: 'new', iid: '43' }), task({ runId: 'focused', iid: '42' })];

    expect(getTaskSelectionIndex(tasks, 'focused', 0)).toBe(1);
    expect(getTaskSelectionIndex(tasks, 'missing', 8)).toBe(1);
  });
});
