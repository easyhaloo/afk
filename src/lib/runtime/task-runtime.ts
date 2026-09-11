import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type TaskRuntimePhase = 'implementing' | 'verifying';
export type TaskRuntimeStatus = 'running' | 'completed' | 'blocked' | 'failed';
export type VisibleTaskRuntimeStatus = TaskRuntimeStatus | 'stale';

export interface TaskRuntimeRecord {
  runId: string;
  backlogId: string;
  title?: string;
  phase: TaskRuntimePhase;
  status: TaskRuntimeStatus;
  sandboxProvider: string;
  executionMode: 'interactive' | 'batch';
  agentProvider: string;
  session?: string;
  worktree?: string;
  branch?: string;
  startedAt: string;
  heartbeatAt: string;
  progress?: string;
  diagnosticPath?: string;
  errorSummary?: string;
  completedAt?: string;
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

export class TaskRuntimeStore {
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

  async start(record: TaskRuntimeRecord): Promise<void> {
    const activeRecord = {
      ...record,
      diagnosticPath: record.diagnosticPath ?? this.diagnosticPathFor(record.runId),
    };
    await fs.mkdir(activeRecord.diagnosticPath, { recursive: true });
    await this.atomicWriteFile(join(activeRecord.diagnosticPath, 'runtime.json'), JSON.stringify(activeRecord, null, 2));
    await this.write(this.activePath, activeRecord);
  }

  async getActive(runId: string): Promise<TaskRuntimeRecord | undefined> {
    return this.read(join(this.activePath, `${runtimeFileKey(runId)}.json`));
  }

  async update(runId: string, changes: Partial<Omit<TaskRuntimeRecord, 'runId' | 'startedAt' | 'status'>>): Promise<TaskRuntimeRecord> {
    const current = await this.getActive(runId);
    if (!current) throw new Error(`active task runtime '${runId}' was not found`);
    const lastHeartbeat = Date.parse(current.heartbeatAt);
    const heartbeatAt = new Date(Math.max(Date.now(), lastHeartbeat + 1)).toISOString();
    const updated: TaskRuntimeRecord = { ...current, ...changes, heartbeatAt };
    await this.write(this.activePath, updated);
    return updated;
  }

  async finish(runId: string, changes: Pick<Partial<TaskRuntimeRecord>, 'status' | 'progress' | 'diagnosticPath' | 'errorSummary'>): Promise<TaskRuntimeRecord> {
    const current = await this.getActive(runId);
    if (!current) throw new Error(`active task runtime '${runId}' was not found`);
    const status = changes.status ?? 'completed';
    if (status === 'running') throw new Error('terminal task runtime status is required');
    const terminal: TaskRuntimeRecord = {
      ...current,
      ...changes,
      status,
      completedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    await this.write(this.archivePath, terminal);
    await fs.rm(join(this.activePath, `${runtimeFileKey(runId)}.json`), { force: true });
    return terminal;
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
      return isTaskRuntimeRecord(value) ? value : undefined;
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
    const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporaryPath, content, 'utf8');
    await fs.rename(temporaryPath, path);
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
    this.staleAfterMs = options.staleAfterMs ?? 5 * 60 * 1000;
  }

  start(record: TaskRuntimeRecord): Promise<void> {
    return this.store.start(record);
  }

  heartbeat(runId: string, changes: Partial<Pick<TaskRuntimeRecord, 'phase' | 'progress' | 'diagnosticPath' | 'worktree' | 'branch'>> = {}): Promise<TaskRuntimeRecord> {
    return this.store.update(runId, changes);
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
      status: now - Date.parse(record.heartbeatAt) > this.staleAfterMs ? 'stale' : 'running',
    }));
  }
}

function isTaskRuntimeRecord(value: unknown): value is TaskRuntimeRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<TaskRuntimeRecord>;
  return typeof record.runId === 'string'
    && typeof record.backlogId === 'string'
    && (record.phase === 'implementing' || record.phase === 'verifying')
    && typeof record.status === 'string'
    && typeof record.sandboxProvider === 'string'
    && (record.executionMode === 'interactive' || record.executionMode === 'batch')
    && typeof record.agentProvider === 'string'
    && typeof record.startedAt === 'string'
    && typeof record.heartbeatAt === 'string';
}
