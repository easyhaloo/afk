export type TaskActivityKind = 'agent' | 'tool' | 'test' | 'state' | 'qa' | 'error';

export interface TaskActivity {
  id: string;
  taskRunId: string;
  at: Date;
  kind: TaskActivityKind;
  message: string;
  detail?: string;
}

export interface Task {
  /** Canonical backlog ID; intentionally not a tracker-specific issue number. */
  iid: string;
  runId: string;
  title: string;
  phase: 'implementing' | 'verifying';
  executionMode: 'interactive' | 'batch';
  sandboxProvider: string;
  agentProvider: string;
  branch?: string;
  session?: string;
  status: 'active' | 'stale';
  progress?: string;
  startedAt?: Date;
  heartbeatAt?: Date;
  worktree?: string;
  diagnosticPath?: string;
  errorSummary?: string;
  activities?: TaskActivity[];
}

export interface Project {
  id: number;
  platform?: 'github' | 'gitlab';
  name: string;
  path_with_namespace: string;
  description?: string;
  default_branch?: string;
  namespace: { name: string };
  last_activity_at?: string;
  web_url?: string;
}
