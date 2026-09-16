import type { BacklogItem } from '../../../lib/core/backlog';
import type {
  ActiveTaskRuntimeRecord,
  TaskRuntimePhase,
  TaskRuntimeRecord,
  TaskRuntimeStatus,
} from '../../../application/runtime/task-runtime';

export type ProjectedRunStatus = TaskRuntimeStatus | 'stale';
type BacklogProjectionItem = Pick<BacklogItem, 'id' | 'title' | 'state' | 'providerRef'>;

export interface WorkItemProjection {
  backlogId: string;
  backlog?: BacklogProjectionItem;
  backlogState?: BacklogItem['state'];
  runId?: string;
  runStatus?: ProjectedRunStatus;
  phase?: TaskRuntimePhase;
  runtime?: TaskRuntimeRecord | ActiveTaskRuntimeRecord;
}

export interface WorkItemProjectionInput {
  backlogs: readonly BacklogProjectionItem[];
  active: readonly ActiveTaskRuntimeRecord[];
  archive?: readonly TaskRuntimeRecord[];
  workspace?: string;
  now?: number;
  staleAfterMs?: number;
}

const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;

export function projectWorkItems({
  backlogs,
  active,
  archive = [],
  workspace,
  now = Date.now(),
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
}: WorkItemProjectionInput): WorkItemProjection[] {
  const backlogById = new Map<string, BacklogProjectionItem>();
  const ids: string[] = [];

  for (const item of backlogs) {
    if (!backlogById.has(item.id)) ids.push(item.id);
    backlogById.set(item.id, item);
  }

  const latestRuntimeByBacklogId = new Map<string, TaskRuntimeRecord | ActiveTaskRuntimeRecord>();
  for (const runtime of [...active, ...archive]) {
    const backlog = backlogById.get(runtime.backlogId);
    if (!runtimeBelongsToWorkspace(runtime, backlog, workspace)) continue;
    const current = latestRuntimeByBacklogId.get(runtime.backlogId);
    if (!current || isNewerRuntime(runtime, current)) latestRuntimeByBacklogId.set(runtime.backlogId, runtime);
    if (!backlogById.has(runtime.backlogId) && !ids.includes(runtime.backlogId)) ids.push(runtime.backlogId);
  }

  return ids.map(backlogId => {
    const backlog = backlogById.get(backlogId);
    const runtime = latestRuntimeByBacklogId.get(backlogId);
    return {
      backlogId,
      backlog,
      backlogState: backlog?.state,
      runId: runtime?.runId,
      runStatus: runtime ? visibleRunStatus(runtime, now, staleAfterMs) : undefined,
      phase: runtime?.phase,
      runtime,
    };
  });
}

function runtimeBelongsToWorkspace(
  runtime: TaskRuntimeRecord | ActiveTaskRuntimeRecord,
  backlog: BacklogProjectionItem | undefined,
  workspace: string | undefined,
): boolean {
  if (runtime.workspace !== undefined) {
    if (workspace !== undefined && runtime.workspace !== workspace) return false;
  } else if (workspace !== undefined && !runtime.worktree?.startsWith(`${workspace}/`)) {
    return false;
  }
  if (runtime.providerRef !== undefined && backlog !== undefined && runtime.providerRef !== backlog.providerRef) return false;
  return true;
}

function isNewerRuntime(
  candidate: TaskRuntimeRecord | ActiveTaskRuntimeRecord,
  current: TaskRuntimeRecord | ActiveTaskRuntimeRecord,
): boolean {
  const candidateHeartbeat = Date.parse(candidate.heartbeatAt);
  const currentHeartbeat = Date.parse(current.heartbeatAt);
  if (candidateHeartbeat !== currentHeartbeat) return candidateHeartbeat > currentHeartbeat;
  const candidateStarted = Date.parse(candidate.startedAt);
  const currentStarted = Date.parse(current.startedAt);
  if (candidateStarted !== currentStarted) return candidateStarted > currentStarted;
  return candidate.runId > current.runId;
}

function visibleRunStatus(
  runtime: TaskRuntimeRecord | ActiveTaskRuntimeRecord,
  now: number,
  staleAfterMs: number,
): ProjectedRunStatus {
  if (runtime.status !== 'running') return runtime.status;
  const heartbeat = Date.parse(runtime.heartbeatAt);
  return Number.isFinite(heartbeat) && now - heartbeat > staleAfterMs ? 'stale' : 'running';
}
