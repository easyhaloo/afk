import type { BacklogState } from '../domain/backlog';
import type { TaskRuntimeActivity, TaskRuntimeStatus } from '../application/runtime/task-runtime';

export type TaskActivity = Omit<TaskRuntimeActivity, 'at'> & { at: Date };

export function getTaskBacklogId(task: Pick<Task, 'backlogId'>): string {
  return task.backlogId || 'unknown';
}

export interface Task {
  /** Canonical identity used to join runtime records to backlog items. */
  backlogId: string;
  /** Deprecated compatibility alias for backlogId. */
  iid?: string;
  runId: string;
  title: string;
  phase: 'implementing' | 'verifying';
  executionMode: 'interactive' | 'batch';
  sandboxProvider: string;
  agentProvider: string;
  branch?: string;
  session?: string;
  status: 'active' | 'stale';
  backlogState?: BacklogState;
  runStatus?: TaskRuntimeStatus | 'stale';
  activities?: TaskActivity[];
  progress?: string;
  startedAt?: Date;
  heartbeatAt?: Date;
  worktree?: string;
  diagnosticPath?: string;
  errorSummary?: string;
}

export interface Project {
  id: number;
  name: string;
  path_with_namespace: string;
  description?: string;
  default_branch?: string;
  namespace: { name: string };
  last_activity_at?: string;
  web_url?: string;
}
