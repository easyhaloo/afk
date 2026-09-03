import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

type SQLiteStatement = {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
};

type SQLiteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SQLiteStatement;
  close(): void;
};

const requireNode = createRequire(import.meta.url);
// Constructing the specifier avoids Vite versions that do not yet recognise node:sqlite as a builtin.
const { DatabaseSync } = requireNode(`node:${'sqlite'}`) as { DatabaseSync: new (path: string) => SQLiteDatabase };

export type AfkResourceKind = 'tmux' | 'container' | 'isolate-service';
export type AfkResourceOrigin = 'local-sandbox' | 'container-sandbox' | 'isolate';
export type AfkResourceStatus = 'active' | 'closed' | 'missing' | 'failed';

export interface AfkResourceRecord {
  id: string;
  resourceKey: string;
  workspacePath: string;
  runId?: string;
  worktreePath: string;
  kind: AfkResourceKind;
  origin: AfkResourceOrigin;
  engine?: 'docker' | 'podman';
  name: string;
  externalId?: string;
  status: AfkResourceStatus;
  detail?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface RegisterAfkResource {
  workspacePath: string;
  runId?: string;
  worktreePath: string;
  kind: AfkResourceKind;
  origin: AfkResourceOrigin;
  engine?: 'docker' | 'podman';
  name: string;
  externalId?: string;
  detail?: string;
  metadata?: Record<string, unknown>;
}

export interface AfkResourceRegistryOptions {
  databasePath?: string;
}

type ResourceRow = {
  id: string;
  resource_key: string;
  workspace_path: string;
  run_id: string | null;
  worktree_path: string;
  kind: AfkResourceKind;
  origin: AfkResourceOrigin;
  engine: 'docker' | 'podman' | null;
  name: string;
  external_id: string | null;
  status: AfkResourceStatus;
  detail: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

/**
 * Durable local ownership registry for resources created by AFK.
 *
 * It intentionally stores only AFK-created resource identities. Consumers must
 * query this registry first and then inspect each recorded resource by exact
 * name/ID; they must never infer ownership from global docker or tmux listings.
 */
export class AfkResourceRegistry {
  readonly databasePath: string;
  private readonly db: SQLiteDatabase;

  constructor(options: AfkResourceRegistryOptions = {}) {
    this.databasePath = resolve(options.databasePath ?? join(homedir(), '.afk', 'runtime', 'resources.sqlite'));
    mkdirSync(dirname(this.databasePath), { recursive: true });
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
    this.migrate();
  }

  register(input: RegisterAfkResource): AfkResourceRecord {
    const workspacePath = resolve(input.workspacePath);
    const worktreePath = resolve(input.worktreePath);
    const resourceKey = resourceKeyFor({ ...input, workspacePath, worktreePath });
    const now = new Date().toISOString();
    const id = randomUUID();
    const metadata = JSON.stringify(input.metadata ?? {});
    this.db.prepare(`
      INSERT INTO afk_resources (
        id, resource_key, workspace_path, run_id, worktree_path, kind, origin,
        engine, name, external_id, status, detail, metadata_json, created_at, updated_at, closed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL)
      ON CONFLICT(resource_key) DO UPDATE SET
        run_id = excluded.run_id,
        engine = excluded.engine,
        external_id = excluded.external_id,
        status = 'active',
        detail = excluded.detail,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at,
        closed_at = NULL
    `).run(
      id,
      resourceKey,
      workspacePath,
      input.runId ?? null,
      worktreePath,
      input.kind,
      input.origin,
      input.engine ?? null,
      input.name,
      input.externalId ?? null,
      input.detail ?? null,
      metadata,
      now,
      now,
    );
    const record = this.getByKey(resourceKey);
    if (!record) throw new Error(`failed to persist AFK resource '${input.name}'`);
    return record;
  }

  listActive(workspacePath: string): AfkResourceRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM afk_resources
      WHERE workspace_path = ? AND status = 'active'
      ORDER BY updated_at DESC, name ASC
    `).all(resolve(workspacePath)) as ResourceRow[];
    return rows.map(rowToRecord);
  }

  listByRun(runId: string): AfkResourceRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM afk_resources
      WHERE run_id = ?
      ORDER BY updated_at DESC, name ASC
    `).all(runId) as ResourceRow[];
    return rows.map(rowToRecord);
  }

  markClosed(input: Pick<RegisterAfkResource, 'workspacePath' | 'worktreePath' | 'kind' | 'origin' | 'name'> & { status?: Extract<AfkResourceStatus, 'closed' | 'missing' | 'failed'>; detail?: string }): void {
    const resourceKey = resourceKeyFor({ ...input, workspacePath: resolve(input.workspacePath), worktreePath: resolve(input.worktreePath) });
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE afk_resources
      SET status = ?, detail = COALESCE(?, detail), updated_at = ?, closed_at = ?
      WHERE resource_key = ? AND status = 'active'
    `).run(input.status ?? 'closed', input.detail ?? null, now, now, resourceKey);
  }

  closeActiveForWorktree(workspacePath: string, worktreePath: string, origin: AfkResourceOrigin): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE afk_resources
      SET status = 'closed', updated_at = ?, closed_at = ?
      WHERE workspace_path = ? AND worktree_path = ? AND origin = ? AND status = 'active'
    `).run(now, now, resolve(workspacePath), resolve(worktreePath), origin);
  }

  private getByKey(resourceKey: string): AfkResourceRecord | undefined {
    const row = this.db.prepare('SELECT * FROM afk_resources WHERE resource_key = ?').get(resourceKey) as ResourceRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS afk_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS afk_resources (
        id TEXT PRIMARY KEY,
        resource_key TEXT NOT NULL UNIQUE,
        workspace_path TEXT NOT NULL,
        run_id TEXT,
        worktree_path TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('tmux', 'container', 'isolate-service')),
        origin TEXT NOT NULL CHECK(origin IN ('local-sandbox', 'container-sandbox', 'isolate')),
        engine TEXT CHECK(engine IN ('docker', 'podman')),
        name TEXT NOT NULL,
        external_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('active', 'closed', 'missing', 'failed')),
        detail TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS afk_resources_workspace_active_idx
        ON afk_resources(workspace_path, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS afk_resources_run_idx
        ON afk_resources(run_id, updated_at DESC);
    `);
    this.db.prepare('INSERT OR IGNORE INTO afk_schema_migrations(version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
  }
}

let defaultRegistry: AfkResourceRegistry | undefined;

export function getAfkResourceRegistry(): AfkResourceRegistry {
  defaultRegistry ??= new AfkResourceRegistry();
  return defaultRegistry;
}

/** Map an AFK-managed `.worktrees/<name>` child back to its project workspace. */
export function workspaceRootForWorktree(worktreePath: string): string {
  const absolute = resolve(worktreePath);
  const marker = `${join('/', '.worktrees')}/`;
  const normalized = absolute.replaceAll('\\', '/');
  const index = normalized.indexOf(marker);
  return index >= 0 ? normalized.slice(0, index) : absolute;
}

function resourceKeyFor(input: Pick<RegisterAfkResource, 'workspacePath' | 'worktreePath' | 'kind' | 'origin' | 'name'>): string {
  return createHash('sha256')
    .update([input.workspacePath, input.worktreePath, input.kind, input.origin, input.name].join('\u0000'))
    .digest('hex');
}

function rowToRecord(row: ResourceRow): AfkResourceRecord {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.metadata_json) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
  } catch {
    // Older/corrupt metadata must not make environment discovery fail.
  }
  return {
    id: row.id,
    resourceKey: row.resource_key,
    workspacePath: row.workspace_path,
    runId: row.run_id ?? undefined,
    worktreePath: row.worktree_path,
    kind: row.kind,
    origin: row.origin,
    engine: row.engine ?? undefined,
    name: row.name,
    externalId: row.external_id ?? undefined,
    status: row.status,
    detail: row.detail ?? undefined,
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at ?? undefined,
  };
}
