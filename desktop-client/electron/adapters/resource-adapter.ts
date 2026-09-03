import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { exec, executable } from "./process-executor";

type AfkResourceRow = {
  workspace_path: string;
  kind: "tmux" | "container" | "isolate-service";
  origin: "local-sandbox" | "container-sandbox" | "isolate";
  engine: "docker" | "podman" | null;
  name: string;
  external_id: string | null;
  detail: string | null;
};

type SQLiteStatement = { all(...params: unknown[]): unknown[] };
type SQLiteDatabase = { prepare(sql: string): SQLiteStatement; close(): void };
type SQLiteDatabaseSync = new (path: string, options?: { readOnly?: boolean }) => SQLiteDatabase;

function readAfkResources(workspace: string): AfkResourceRow[] {
  const databasePath = path.join(homedir(), ".afk", "runtime", "resources.sqlite");
  if (!existsSync(databasePath)) return [];
  try {
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: SQLiteDatabaseSync };
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const resolved = path.resolve(workspace);
      const root = workspaceRootForSelectedPath(resolved);
      return db.prepare(`
        SELECT workspace_path, kind, origin, engine, name, external_id, detail
        FROM afk_resources
        WHERE workspace_path IN (?, ?) AND status = 'active'
        ORDER BY updated_at DESC, name ASC
      `).all(resolved, root) as AfkResourceRow[];
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function workspaceRootForSelectedPath(selected: string): string {
  const marker = `${path.sep}.worktrees${path.sep}`;
  const index = selected.indexOf(marker);
  return index >= 0 ? selected.slice(0, index) : selected;
}

export async function listAfkContainers(workspace: string) {
  const output: Array<{ engine: string; name: string; image: string; status: string }> = [];
  for (const resource of readAfkResources(workspace).filter((item) => item.kind === "container" || item.kind === "isolate-service")) {
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

export async function listAfkTmux(workspace: string) {
  if (!(await executable("tmux"))) return [] as Array<{ name: string; windows: string; attached: boolean }>;
  const names = [...new Set(readAfkResources(workspace).filter((item) => item.kind === "tmux").map((item) => item.name))];
  const output: Array<{ name: string; windows: string; attached: boolean }> = [];
  for (const name of names) {
    const exists = await exec("tmux", ["has-session", "-t", name]);
    if (!exists.ok) continue;
    const result = await exec("tmux", ["display-message", "-p", "-t", name, "#{session_windows}\t#{session_attached}"]);
    if (!result.ok) continue;
    const [windows, attached] = result.stdout.split("\t");
    output.push({ name, windows: windows || "0", attached: attached === "1" });
  }
  return output;
}

export function isAfkTmuxSession(workspace: string, name: string) {
  return readAfkResources(workspace).some((resource) => resource.kind === "tmux" && resource.name === name);
}
