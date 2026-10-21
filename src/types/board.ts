import type { AgentExecutionMode } from '@afk/core';
import type { BacklogState } from '@afk/application';
import type { TaskRuntimeActivity, TaskRuntimePhase, TaskRuntimeStatus } from '@afk/core';

export type TaskActivity = Omit<TaskRuntimeActivity, 'at'> & { at: Date };

export function getTaskBacklogId(task: Pick<Task, 'backlogId'>): string {
  return task.backlogId || 'unknown';
}

export interface Task {
  /**
   * Canonical identity used to join runtime records to backlog items.
   *
   * A record that does not know its backlog item has none, and the join
   * skips it rather than guessing from the legacy aliases — so the field is
   * optional, and the code that reads it says so.
   */
  backlogId?: string;
  /** Deprecated compatibility alias for backlogId. */
  iid?: string;
  runId: string;
  title: string;
  phase: TaskRuntimePhase;
  /**
   * The environment a run published. A record written before these fields
   * existed does not know them, and the board does not guess.
   */
  executionMode?: AgentExecutionMode;
  sandboxProvider?: string;
  agentProvider?: string;
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
