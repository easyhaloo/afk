import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BacklogRunSummary } from "../../shared/backlog-contract";

const RUN_STORE_FILE = "backlog-runs.json";

export type BacklogRunStoreDeps = {
  resolveWorkspace: (input: string) => string;
};

export function createBacklogRunStore(deps: BacklogRunStoreDeps) {
  function filePath(workspace: string): string {
    return path.join(deps.resolveWorkspace(workspace), ".afk", RUN_STORE_FILE);
  }

  async function load(workspace: string): Promise<BacklogRunSummary[]> {
    const raw = await readFile(filePath(workspace), "utf8").catch(() => "");
    if (!raw.trim()) return [];
    try {
      const value = JSON.parse(raw) as unknown;
      if (!Array.isArray(value)) return [];
      return value.filter(isRunSummary);
    } catch {
      return [];
    }
  }

  async function save(workspace: string, runs: BacklogRunSummary[]): Promise<void> {
    const target = filePath(workspace);
    const directory = path.dirname(target);
    const temporary = `${target}.${process.pid}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, JSON.stringify(runs, null, 2), "utf8");
    await rename(temporary, target);
  }

  return { load, save };
}

function isRunSummary(value: unknown): value is BacklogRunSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string"
    && typeof candidate.backlogId === "string"
    && typeof candidate.startedAt === "string"
    && (candidate.status === "starting" || candidate.status === "running" || candidate.status === "completed" || candidate.status === "failed")
    && (candidate.template === undefined || typeof candidate.template === "string")
    && (candidate.pid === undefined || typeof candidate.pid === "number")
    && (candidate.error === undefined || typeof candidate.error === "string");
}
