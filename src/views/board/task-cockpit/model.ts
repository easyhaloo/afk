import type { Task } from '../../../types/board';
import { truncateByVisualWidth } from '../utils';

export function getTaskQueue(tasks: Task[]): Task[] {
  return [...tasks].sort((left, right) => {
      if (left.status !== right.status) return left.status === 'active' ? -1 : 1;
      const leftHeartbeat = left.heartbeatAt?.getTime() ?? 0;
      const rightHeartbeat = right.heartbeatAt?.getTime() ?? 0;
      return rightHeartbeat - leftHeartbeat;
    });
}

export function getTaskSelectionIndex(tasks: Task[], focusedRunId: string | undefined, fallbackIndex: number): number {
  const focusedIndex = focusedRunId ? tasks.findIndex(task => task.runId === focusedRunId) : -1;
  if (focusedIndex >= 0) return focusedIndex;
  return Math.min(Math.max(0, fallbackIndex), Math.max(0, tasks.length - 1));
}

export function getActivityLimit(width: number): number {
  if (width < 80) return 2;
  if (width < 120) return 4;
  return Number.POSITIVE_INFINITY;
}

export function getTaskPhaseLabel(task: Task): string {
  return task.phase === 'verifying' ? 'verification' : 'processing';
}

export function getTaskProgress(task: Task): number {
  const match = task.progress?.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!match) return 0;
  const value = Number(match[1]);
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}

export function truncateTaskText(text: string, maxWidth: number): string {
  return truncateByVisualWidth(text, Math.max(1, maxWidth));
}
