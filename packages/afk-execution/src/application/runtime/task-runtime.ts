import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { RUNTIME_STALE_AFTER_MS } from '@afk/application';
import { TASK_RUNTIME_PHASES, type TaskRuntimePhase } from '../../domain/runtime/phase.js';
import {
  AGENT_AUTHS,
  AGENT_TRANSPORTS,
  isAgentExecutionMode,
  type AgentAuth,
  type AgentExecutionMode,
  type AgentTransport,
} from '@afk/core';

/**
 * The phases a task runtime record can be in.
 *
 * The rule lives in the domain layer, where the desktop's renderer can
 * read it too, and the record module names it from there.
 */
export { TASK_RUNTIME_PHASES } from '../../domain/runtime/phase.js';
export type { TaskRuntimePhase } from '../../domain/runtime/phase.js';
export type TaskRuntimeStatus = 'running' | 'completed' | 'blocked' | 'failed';
export type VisibleTaskRuntimeStatus = TaskRuntimeStatus | 'stale';
export type TaskRuntimeActivityKind = 'agent' | 'tool' | 'test' | 'state' | 'qa' | 'error';

export interface TaskRuntimeActivity {
  id: string;
  taskRunId: string;
  at: string;
  kind: TaskRuntimeActivityKind;
  message: string;
  detail?: string;
}

/**
 * The read model — a runtime record as history knows it.
 *
 * `sandboxProvider`, `executionMode` and `agentProvider` are optional here,
 * because history does not always know them: a record written before those
 * fields existed is still history, and a reader that demanded them would
 * drop it. Nothing is invented in their place — a record that does not
 * carry them says so.
 */
export interface TaskRuntimeRecord {
  runId: string;
  backlogId: string;
  workspace?: string;
  providerRef?: string;
  title?: string;
  phase: TaskRuntimePhase;
  status: TaskRuntimeStatus;
  sandboxProvider?: string;
  executionMode?: AgentExecutionMode;
  agentProvider?: string;
  agentTransport?: AgentTransport;
  agentAuth?: AgentAuth;
  agentModelProvider?: string;
  agentThreadId?: string;
  session?: string;
  worktree?: string;
  branch?: string;
  startedAt: string;
  heartbeatAt: string;
  progress?: string;
  diagnosticPath?: string;
  errorSummary?: string;
  completedAt?: string;
  activities?: TaskRuntimeActivity[];
}

/**
 * The write model — what a run publishes about its environment.
 *
 * A run knows the sandbox it ran in, the mode it ran in and the agent it
 * ran, so all three are required here. The read model is looser only
 * because the past is looser; every runner publishes through
 * `runtimeRecord()`, which always fills them in.
 */
export interface TaskRuntimeRecordInput extends Omit<TaskRuntimeRecord, 'sandboxProvider' | 'executionMode' | 'agentProvider'> {
  sandboxProvider: string;
  executionMode: AgentExecutionMode;
  agentProvider: string;
}

export type ActiveTaskRuntimeRecord = Omit<TaskRuntimeRecord, 'status'> & {
  status: 'running' | 'stale';
};

export interface TaskRuntimeStoreOptions {
  root?: string;
}

export interface TaskRuntimeDiagnostics {
  result?: unknown;
  output?: string;
}

/**
 * Which runtime records belong to a work item.
 *
 * Two readers used to answer this differently: one matched on `providerRef`
 * and ignored the workspace, the other matched on `backlogId` and required
 * the workspace. The same record could therefore be shown by one view and
 * hidden by the other, and the two views could answer "is this run still
 * going?" differently for the same run.
 *
 * The rule is per field, and strict: a caller that knows the provider-
 * qualified work item id requires the record's `providerRef` to match it,
 * and a caller that knows the provider's own backlog id requires
 * `backlogId` to match. The workspace is compared when both sides know it;
 * a record that declares only a worktree is accepted when that worktree
 * sits inside the workspace.
 */
export interface RuntimeRecordIdentity {
  /** The provider-qualified work item id, e.g. `github:org/repo#42`. */
  workItemId?: string;
  /** The provider's own backlog id, e.g. `42`. */
  backlogId?: string;
  /** The workspace root the record must belong to. */
  workspace?: string;
}

export function matchesRuntimeRecord(
  record: Partial<Pick<TaskRuntimeRecord, 'runId' | 'backlogId' | 'providerRef' | 'workspace' | 'worktree'>>,
  identity: RuntimeRecordIdentity,
): boolean {
  if (identity.workItemId !== undefined && record.providerRef !== undefined && record.providerRef !== identity.workItemId) return false;
  if (identity.backlogId !== undefined && record.backlogId !== identity.backlogId) return false;
  if (identity.workspace === undefined) return true;
  if (record.workspace !== undefined) {
    return resolve(identity.workspace) === resolve(record.workspace);
  }
  if (record.worktree !== undefined) {
    return isWithinWorkspace(record.worktree, identity.workspace);
  }
  // Neither a workspace nor a worktree: the record cannot be placed, so it
  // does not belong here.
  return false;
}

function isWithinWorkspace(candidate: string, workspace: string): boolean {
  const root = resolve(workspace);
  const target = resolve(candidate);
  return target === root || target.startsWith(`${root}${sep}`);
}

/**
 * Whether a record's heartbeat has gone cold.
 *
 * The window lives here so that every surface judges a run the same way.
 * The desktop used to keep its own copy of the rule, and the same run could
 * be stale in one view and live in another.
 */
export function isRuntimeStale(heartbeatAt: string, now: number, staleAfterMs: number): boolean {
  const heartbeat = Date.parse(heartbeatAt);
  return Number.isFinite(heartbeat) && now - heartbeat > staleAfterMs;
}

/**
 * The status a record in the active bucket shows: it is still running, until
 * its heartbeat goes cold.
 */
export function activeRuntimeStatus(record: TaskRuntimeRecord, now: number, staleAfterMs: number): 'running' | 'stale' {
  return isRuntimeStale(record.heartbeatAt, now, staleAfterMs) ? 'stale' : 'running';
}

export class TaskRuntimeStore {
  private readonly mutations = new Map<string, Promise<void>>();
  readonly root: string;
  readonly activePath: string;
  readonly archivePath: string;
  readonly diagnosticsPath: string;

  constructor(options: string | TaskRuntimeStoreOptions = {}) {
    this.root = typeof options === 'string'
      ? options
      : options.root ?? join(homedir(), '.afk', 'runtime', 'tasks');
    this.activePath = join(this.root, 'active');
    this.archivePath = join(this.root, 'archive');
    this.diagnosticsPath = join(this.root, 'diagnostics');
  }

  async start(record: TaskRuntimeRecordInput): Promise<void> {
    const startedActivity: TaskRuntimeActivity = {
      id: activityId(record.runId, record.startedAt, 'state', 'runtime started'),
      taskRunId: record.runId,
      at: record.startedAt,
      kind: 'state',
      message: 'runtime started',
    };
    const activeRecord = {
      ...record,
      activities: boundActivities([startedActivity, ...(record.activities ?? [])], record.runId),
      diagnosticPath: record.diagnosticPath ?? this.diagnosticPathFor(record.runId),
    };
    await fs.mkdir(activeRecord.diagnosticPath, { recursive: true });
    await this.atomicWriteFile(join(activeRecord.diagnosticPath, 'runtime.json'), JSON.stringify(activeRecord, null, 2));
    await this.write(this.activePath, activeRecord);
  }

  async getActive(runId: string): Promise<TaskRuntimeRecord | undefined> {
    return this.read(join(this.activePath, `${runtimeFileKey(runId)}.json`));
  }

  async getArchived(runId: string): Promise<TaskRuntimeRecord | undefined> {
    return this.read(join(this.archivePath, `${runtimeFileKey(runId)}.json`));
  }

  async update(runId: string, changes: Partial<Omit<TaskRuntimeRecord, 'runId' | 'startedAt' | 'status' | 'activities'>>): Promise<TaskRuntimeRecord> {
    return this.mutate(runId, async () => {
      const current = await this.getActive(runId);
      if (!current) throw new Error(`active task runtime '${runId}' was not found`);
      const lastHeartbeat = Date.parse(current.heartbeatAt);
      const heartbeatAt = new Date(Math.max(Date.now(), lastHeartbeat + 1)).toISOString();
      const activity = activityForChanges(current, changes);
      const updated: TaskRuntimeRecord = {
        ...current,
        ...changes,
        heartbeatAt,
        activities: activity ? boundActivities([...(current.activities ?? []), activity], runId) : current.activities,
      };
      await this.write(this.activePath, updated);
      return updated;
    });
  }

  async appendActivity(
    runId: string,
    activity: Omit<TaskRuntimeActivity, 'id' | 'taskRunId' | 'at'> & { id?: string; at?: string },
  ): Promise<TaskRuntimeRecord> {
    return this.mutate(runId, async () => {
      const current = await this.getActive(runId);
      if (!current) throw new Error(`active task runtime '${runId}' was not found`);
      const at = activity.at || new Date().toISOString();
      const next: TaskRuntimeActivity = {
        ...activity,
        id: activity.id ?? activityId(runId, at, activity.kind, activity.message),
        taskRunId: runId,
        at,
      };
      const heartbeatAt = new Date(Math.max(Date.now(), Date.parse(current.heartbeatAt) + 1)).toISOString();
      const updated = { ...current, heartbeatAt, activities: boundActivities([...(current.activities ?? []), next], runId) };
      await this.write(this.activePath, updated);
      return updated;
    });
  }

  async finish(runId: string, changes: Pick<Partial<TaskRuntimeRecord>, 'status' | 'progress' | 'diagnosticPath' | 'errorSummary'>): Promise<TaskRuntimeRecord> {
    return this.mutate(runId, async () => {
      const current = await this.getActive(runId);
      if (!current) throw new Error(`active task runtime '${runId}' was not found`);
      const status = changes.status ?? 'completed';
      if (status === 'running') throw new Error('terminal task runtime status is required');
      const at = new Date().toISOString();
      const terminal: TaskRuntimeRecord = {
        ...current,
        ...changes,
        status,
        completedAt: at,
        heartbeatAt: at,
        activities: boundActivities([...(current.activities ?? []), {
          id: activityId(current.runId, at, 'state', `runtime ${status}`),
          taskRunId: current.runId,
          at,
          kind: 'state',
          message: `runtime ${status}`,
        }], runId),
      };
      await this.write(this.archivePath, terminal);
      await fs.rm(join(this.activePath, `${runtimeFileKey(runId)}.json`), { force: true });
      return terminal;
    });
  }

  async listActive(): Promise<TaskRuntimeRecord[]> {
    return this.list(this.activePath);
  }

  async listArchive(): Promise<TaskRuntimeRecord[]> {
    return this.list(this.archivePath);
  }

  diagnosticPathFor(runId: string): string {
    return join(this.diagnosticsPath, runtimeFileKey(runId));
  }

  async writeDiagnostics(runId: string, diagnostics: TaskRuntimeDiagnostics): Promise<string> {
    const record = await this.getActive(runId);
    if (!record) throw new Error(`active task runtime '${runId}' was not found`);
    const path = this.diagnosticPathFor(runId);
    await fs.mkdir(path, { recursive: true });
    if (diagnostics.result !== undefined) {
      await this.atomicWriteFile(join(path, 'result.json'), JSON.stringify(diagnostics.result, null, 2));
    }
    if (diagnostics.output !== undefined) {
      await this.atomicWriteFile(join(path, 'output.log'), diagnostics.output);
    }
    await this.update(runId, { diagnosticPath: path });
    return path;
  }

  private async list(directory: string): Promise<TaskRuntimeRecord[]> {
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records = await Promise.all(names
      .filter(name => name.endsWith('.json'))
      .map(name => this.read(join(directory, name))));
    return records
      .filter((record): record is TaskRuntimeRecord => record !== undefined)
      .sort((left, right) => right.heartbeatAt.localeCompare(left.heartbeatAt));
  }

  private async read(path: string): Promise<TaskRuntimeRecord | undefined> {
    try {
      const value: unknown = JSON.parse(await fs.readFile(path, 'utf8'));
      if (!isTaskRuntimeRecord(value)) return undefined;
      const activities = Array.isArray(value.activities)
        ? boundActivities(value.activities, value.runId)
        : undefined;
      return { ...value, activities };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return undefined;
    }
  }

  private async write(directory: string, record: TaskRuntimeRecord): Promise<void> {
    await fs.mkdir(directory, { recursive: true });
    const path = join(directory, `${runtimeFileKey(record.runId)}.json`);
    await this.atomicWriteFile(path, JSON.stringify(record, null, 2));
  }

  private async atomicWriteFile(path: string, content: string): Promise<void> {
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, content, 'utf8');
    await fs.rename(temporaryPath, path);
  }

  private async mutate<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(runId) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.mutations.set(runId, tail);
    try {
      return await result;
    } finally {
      if (this.mutations.get(runId) === tail) this.mutations.delete(runId);
    }
  }
}

/** Map externally-derived run IDs to a single safe filesystem path segment. */
function runtimeFileKey(runId: string): string {
  const key = Buffer.from(runId, 'utf8').toString('base64url');
  if (!key) throw new Error('task runtime runId is required');
  return key;
}

export interface TaskRuntimeManagerOptions {
  staleAfterMs?: number;
}

export class TaskRuntimeManager {
  private readonly staleAfterMs: number;

  constructor(readonly store = new TaskRuntimeStore(), options: TaskRuntimeManagerOptions = {}) {
    this.staleAfterMs = options.staleAfterMs ?? RUNTIME_STALE_AFTER_MS;
  }

  start(record: TaskRuntimeRecordInput): Promise<void> {
    return this.store.start(record);
  }

  heartbeat(runId: string, changes: Partial<Pick<TaskRuntimeRecord, 'phase' | 'progress' | 'diagnosticPath' | 'worktree' | 'branch' | 'errorSummary' | 'agentProvider' | 'agentTransport' | 'agentAuth' | 'agentModelProvider' | 'agentThreadId'>> = {}): Promise<TaskRuntimeRecord> {
    return this.store.update(runId, changes);
  }

  appendActivity(runId: string, activity: Omit<TaskRuntimeActivity, 'id' | 'taskRunId' | 'at'> & { id?: string; at?: string }): Promise<TaskRuntimeRecord> {
    return this.store.appendActivity(runId, activity);
  }

  finish(runId: string, changes: Pick<Partial<TaskRuntimeRecord>, 'status' | 'progress' | 'diagnosticPath' | 'errorSummary'>): Promise<TaskRuntimeRecord> {
    return this.store.finish(runId, changes);
  }

  writeDiagnostics(runId: string, diagnostics: TaskRuntimeDiagnostics): Promise<string> {
    return this.store.writeDiagnostics(runId, diagnostics);
  }

  async listActive(now = Date.now()): Promise<ActiveTaskRuntimeRecord[]> {
    const active = await this.store.listActive();
    return active.map(record => ({
      ...record,
      status: activeRuntimeStatus(record, now, this.staleAfterMs),
    }));
  }

  listArchive(): Promise<TaskRuntimeRecord[]> {
    return this.store.listArchive();
  }

  async listByBacklogId(backlogId: string, now = Date.now()): Promise<{
    active: ActiveTaskRuntimeRecord[];
    archive: TaskRuntimeRecord[];
  }> {
    const [active, archive] = await Promise.all([this.listActive(now), this.store.listArchive()]);
    return {
      active: active.filter(record => record.backlogId === backlogId),
      archive: archive.filter(record => record.backlogId === backlogId),
    };
  }
}

/** Which bucket a runtime record was found in. */
export type RuntimeRecordBucket = 'active' | 'archive';

/**
 * One runtime record, as the reader found it.
 *
 * The record is the record as it was written: nothing is filled in, and a
 * record that does not know its environment does not claim one. The status
 * is what the record shows — a run in the active bucket is running until
 * its heartbeat goes cold, and an archived run shows the status it was
 * archived with.
 */
export interface RuntimeRecordEntry {
  record: TaskRuntimeRecord;
  bucket: RuntimeRecordBucket;
  status: VisibleTaskRuntimeStatus;
}

/** Which records a reader is asked for. */
export interface RuntimeRecordQuery {
  /** The work item the records must belong to. */
  identity?: RuntimeRecordIdentity;
  /** Only records that started at or after this instant. */
  startedAfter?: string;
}

export interface TaskRuntimeReaderOptions {
  /** The runtime root the records live under. */
  root?: string;
  /** How long a heartbeat may go quiet before the run counts as stale. */
  staleAfterMs?: number;
  /** The clock, injected so a caller decides what "now" means. */
  now?: () => number;
}

/**
 * The one reader for the runtime task records.
 *
 * The desktop used to read the runtime records itself, twice, with two sets
 * of hand-written rules: it listed the buckets, parsed the files, validated
 * the records and judged staleness on its own. The store already owns the
 * layout, the file names and the validation, so the reader is built on the
 * store instead of beside it — the same identity rule, the same staleness
 * window, one answer per record.
 */
export class TaskRuntimeReader {
  readonly store: TaskRuntimeStore;
  private readonly staleAfterMs: number;
  private readonly now: () => number;

  constructor(options: TaskRuntimeReaderOptions = {}, store: TaskRuntimeStore = new TaskRuntimeStore(options.root)) {
    this.store = store;
    this.staleAfterMs = options.staleAfterMs ?? RUNTIME_STALE_AFTER_MS;
    this.now = options.now ?? Date.now;
  }

  /** Every record in both buckets, newest heartbeat first. */
  async list(query: RuntimeRecordQuery = {}): Promise<RuntimeRecordEntry[]> {
    const now = this.now();
    const [active, archive] = await Promise.all([this.store.listActive(), this.store.listArchive()]);
    const startedAfter = query.startedAfter === undefined ? undefined : Date.parse(query.startedAfter);
    const entries = [
      ...active.map(record => this.entry(record, 'active', now)),
      ...archive.map(record => this.entry(record, 'archive', now)),
    ];
    return entries
      .filter(entry => this.belongsTo(entry.record, query.identity))
      .filter(entry => startedAfter === undefined
        || !Number.isFinite(startedAfter)
        || Date.parse(entry.record.startedAt) >= startedAfter)
      .sort((left, right) => Date.parse(right.record.heartbeatAt) - Date.parse(left.record.heartbeatAt));
  }

  /** The record of one run: the active one wins over the archived one. */
  async find(runId: string, identity?: RuntimeRecordIdentity): Promise<RuntimeRecordEntry | undefined> {
    const now = this.now();
    const active = await this.store.getActive(runId);
    if (active && active.runId === runId && this.belongsTo(active, identity)) {
      return this.entry(active, 'active', now);
    }
    const archived = await this.store.getArchived(runId);
    if (archived && archived.runId === runId && this.belongsTo(archived, identity)) {
      return this.entry(archived, 'archive', now);
    }
    return undefined;
  }

  private entry(record: TaskRuntimeRecord, bucket: RuntimeRecordBucket, now: number): RuntimeRecordEntry {
    return {
      record,
      bucket,
      status: bucket === 'active' ? activeRuntimeStatus(record, now, this.staleAfterMs) : record.status,
    };
  }

  private belongsTo(record: TaskRuntimeRecord, identity: RuntimeRecordIdentity | undefined): boolean {
    return identity === undefined ? true : matchesRuntimeRecord(record, identity);
  }
}

function isTaskRuntimeRecord(value: unknown): value is TaskRuntimeRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<TaskRuntimeRecord>;
  return typeof record.runId === 'string'
    && typeof record.backlogId === 'string'
    && (record.phase !== undefined && (TASK_RUNTIME_PHASES as readonly string[]).includes(record.phase))
    && (record.status === 'running' || record.status === 'completed' || record.status === 'blocked' || record.status === 'failed')
    // The three environment fields are the ones history does not always
    // know; a record that carries them must still carry them honestly.
    && (record.sandboxProvider === undefined || typeof record.sandboxProvider === 'string')
    && (record.executionMode === undefined || isAgentExecutionMode(record.executionMode))
    && (record.agentProvider === undefined || typeof record.agentProvider === 'string')
    && (record.agentTransport === undefined || (AGENT_TRANSPORTS as readonly string[]).includes(record.agentTransport))
    && (record.agentAuth === undefined || (AGENT_AUTHS as readonly string[]).includes(record.agentAuth))
    && (record.agentModelProvider === undefined || typeof record.agentModelProvider === 'string')
    && (record.agentThreadId === undefined || typeof record.agentThreadId === 'string')
    && (record.workspace === undefined || typeof record.workspace === 'string')
    && (record.providerRef === undefined || typeof record.providerRef === 'string')
    && typeof record.startedAt === 'string'
    && Number.isFinite(Date.parse(record.startedAt))
    && typeof record.heartbeatAt === 'string'
    && Number.isFinite(Date.parse(record.heartbeatAt));
}

function isTaskRuntimeActivity(value: unknown): value is TaskRuntimeActivity {
  if (!value || typeof value !== 'object') return false;
  const activity = value as Partial<TaskRuntimeActivity>;
  return typeof activity.id === 'string' && activity.id.trim().length > 0
    && typeof activity.taskRunId === 'string' && activity.taskRunId.trim().length > 0
    && typeof activity.at === 'string' && Number.isFinite(Date.parse(activity.at))
    && ['agent', 'tool', 'test', 'state', 'qa', 'error'].includes(activity.kind ?? '')
    && typeof activity.message === 'string' && activity.message.trim().length > 0
    && (activity.detail === undefined || typeof activity.detail === 'string');
}

function boundActivities(activities: TaskRuntimeActivity[], runId?: string): TaskRuntimeActivity[] {
  return [...activities]
    .filter(activity => isTaskRuntimeActivity(activity) && (!runId || activity.taskRunId === runId))
    .sort((left, right) => left.at.localeCompare(right.at))
    .slice(-50);
}

function activityId(runId: string, at: string, kind: TaskRuntimeActivityKind, message: string): string {
  return createHash('sha256').update(`${runId}:${at}:${kind}:${message}`).digest('base64url');
}

function activityForChanges(
  current: TaskRuntimeRecord,
  changes: Partial<Omit<TaskRuntimeRecord, 'runId' | 'startedAt' | 'status' | 'activities'>>,
): TaskRuntimeActivity | undefined {
  const at = new Date().toISOString();
  if (changes.errorSummary) {
    return { id: activityId(current.runId, at, 'error', changes.errorSummary), taskRunId: current.runId, at, kind: 'error', message: changes.errorSummary };
  }
  if (changes.phase && changes.phase !== current.phase) {
    const message = `phase ${changes.phase}`;
    return { id: activityId(current.runId, at, 'state', message), taskRunId: current.runId, at, kind: 'state', message };
  }
  if (changes.progress && changes.progress !== current.progress) {
    return { id: activityId(current.runId, at, 'agent', changes.progress), taskRunId: current.runId, at, kind: 'agent', message: changes.progress };
  }
  return undefined;
}
