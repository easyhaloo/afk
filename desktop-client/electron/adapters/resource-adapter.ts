import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { exec as defaultExec, executable as defaultExecutable } from "./process-executor.js";
import { normalizeTmuxSessionName } from "../../shared/tmux-session.js";

// node:sqlite is loaded through createRequire so this stays synchronous; a
// dynamic import() would force this reader to become async.
const requireCjs = createRequire(import.meta.url);

type AfkResourceRow = {
  id: string;
  workspace_path: string;
  kind: "tmux" | "container" | "isolate-service";
  origin: "local-sandbox" | "container-sandbox" | "isolate";
  engine: "docker" | "podman" | null;
  name: string;
  external_id: string | null;
  detail: string | null;
  status: "active" | "closed" | "missing" | "failed";
  worktree_path: string;
  run_id: string | null;
  updated_at: string;
  metadata_json: string;
};

type SQLiteStatement = { all(...params: unknown[]): unknown[] };
type SQLiteDatabase = { prepare(sql: string): SQLiteStatement; close(): void };
type SQLiteDatabaseSync = new (path: string, options?: { readOnly?: boolean }) => SQLiteDatabase;
type ResourceAdapterDeps = {
  databasePath?: string;
  readResources?: (workspaces: readonly string[]) => AfkResourceRow[];
  exec?: typeof defaultExec;
  executable?: typeof defaultExecutable;
};

function readDatabaseResources(databasePath: string, workspaces: readonly string[]): AfkResourceRow[] {
  if (!existsSync(databasePath)) return [];
  try {
    const { DatabaseSync } = requireCjs("node:sqlite") as { DatabaseSync: SQLiteDatabaseSync };
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const roots = [...new Set(workspaces.map(workspace => path.resolve(workspace)))];
      if (!roots.length) return [];
      const placeholders = roots.map(() => "?").join(", ");
      return db.prepare(`
        SELECT id, workspace_path, kind, origin, engine, name, external_id, detail,
               status, worktree_path, run_id, updated_at, metadata_json
        FROM afk_resources
        WHERE workspace_path IN (${placeholders}) AND status = 'active'
        ORDER BY updated_at DESC, name ASC
      `).all(...roots) as AfkResourceRow[];
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

export function createResourceAdapter(deps: ResourceAdapterDeps = {}) {
  const databasePath = deps.databasePath ?? path.join(homedir(), ".afk", "runtime", "resources.sqlite");
  const readResources = deps.readResources ?? (workspaces => readDatabaseResources(databasePath, workspaces));
  const exec = deps.exec ?? defaultExec;
  const executable = deps.executable ?? defaultExecutable;

  function resources(workspaces: readonly string[]) {
    const allowed = new Set(workspaces.map(workspace => path.resolve(workspace)));
    return readResources(workspaces).filter(resource => allowed.has(path.resolve(resource.workspace_path)));
  }

  async function listAfkContainers(workspaces: readonly string[]) {
    const output: Array<{ engine: string; name: string; image: string; status: string }> = [];
    for (const resource of resources(workspaces).filter(item => item.kind === "container" || item.kind === "isolate-service")) {
      const engine = resource.engine;
      if (!engine || !(await executable(engine))) continue;
      const identifier = resource.external_id || resource.name;
      const result = await exec(engine, ["inspect", "--format", "{{.State.Status}}\t{{.Name}}\t{{.Config.Image}}", identifier]);
      if (!result.ok) continue;
      const [status, rawName, image] = result.stdout.split("\t");
      output.push({ engine, name: (rawName || resource.name).replace(/^\//, ""), image: image || resource.detail || "—", status: status || "unknown" });
    }
    return output;
  }

  async function listAfkTmux(workspaces: readonly string[]) {
    if (!(await executable("tmux"))) return [] as Array<{ workspace: string; name: string; windows: string; attached: boolean; runId?: string; resourceId?: string }>;
    const output: Array<{ workspace: string; name: string; windows: string; attached: boolean; runId?: string; resourceId?: string }> = [];
    for (const resource of resources(workspaces).filter(item => item.kind === "tmux")) {
      const target = normalizeTmuxSessionName(resource.name);
      const exists = await exec("tmux", ["has-session", "-t", target]);
      if (!exists.ok) continue;
      const result = await exec("tmux", ["display-message", "-p", "-t", target, "#{session_windows}\t#{session_attached}"]);
      if (!result.ok) continue;
      const [windows, attached] = result.stdout.split("\t");
      output.push({ workspace: resource.workspace_path, name: resource.name, windows: windows || "0", attached: attached === "1", resourceId: resource.id, ...(resource.run_id ? { runId: resource.run_id } : {}) });
    }
    return output;
  }

  function isAfkTmuxSession(workspaces: readonly string[], name: string, ownerWorkspace?: string) {
    const owner = ownerWorkspace === undefined ? undefined : path.resolve(ownerWorkspace);
    return resources(workspaces).some(resource => resource.kind === "tmux"
      && resource.name === name
      && (owner === undefined || path.resolve(resource.workspace_path) === owner));
  }

  /** Run-scoped resource reader for the ADR-0019 exact attach target path. */
  function listRunResources(runId: string): AfkResourceRow[] {
    if (!existsSync(databasePath)) return [];
    try {
      const { DatabaseSync } = requireCjs("node:sqlite") as { DatabaseSync: SQLiteDatabaseSync };
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        return db.prepare(`
          SELECT id, workspace_path, kind, origin, engine, name, external_id, detail,
                 status, worktree_path, run_id, updated_at, metadata_json
          FROM afk_resources
          WHERE run_id = ?
          ORDER BY updated_at DESC, name ASC
        `).all(runId) as AfkResourceRow[];
      } finally {
        db.close();
      }
    } catch {
      return [];
    }
  }

  return { listAfkContainers, listAfkTmux, isAfkTmuxSession, listRunResources };
}

const resourceAdapter = createResourceAdapter();
export const listAfkContainers = resourceAdapter.listAfkContainers;
export const listAfkTmux = resourceAdapter.listAfkTmux;
export const isAfkTmuxSession = resourceAdapter.isAfkTmuxSession;
export const listRunResources = resourceAdapter.listRunResources;
