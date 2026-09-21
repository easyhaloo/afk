import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkItemRunRecord } from "../../shared/backlog-contract";

const RUN_STORE_FILE = "work-item-runs.json";

export type WorkItemRunStoreDeps = {
  resolveWorkspace: (input: string) => string;
};

export function createWorkItemRunStore(deps: WorkItemRunStoreDeps) {
  function filePath(workspace: string): string {
    return path.join(deps.resolveWorkspace(workspace), ".afk", RUN_STORE_FILE);
  }

  async function load(workspace: string): Promise<WorkItemRunRecord[]> {
    const raw = await readFile(filePath(workspace), "utf8").catch(() => "");
    if (!raw.trim()) return [];
    try {
      const value = JSON.parse(raw) as unknown;
      if (!Array.isArray(value)) return [];
      return value.filter(isWorkItemRunRecord);
    } catch {
      return [];
    }
  }

  async function save(workspace: string, runs: WorkItemRunRecord[]): Promise<void> {
    const target = filePath(workspace);
    const directory = path.dirname(target);
    const temporary = `${target}.${process.pid}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, JSON.stringify(runs, null, 2), "utf8");
    await rename(temporary, target);
  }

  return { load, save };
}

function isWorkItemRunRecord(value: unknown): value is WorkItemRunRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string"
    && (candidate.status === "starting" || candidate.status === "running" || candidate.status === "completed" || candidate.status === "failed")
    && typeof candidate.startedAt === "string"
    && (candidate.completedAt === undefined || typeof candidate.completedAt === "string")
    && (candidate.workflow === undefined || typeof candidate.workflow === "string")
    && (candidate.workspacePath === undefined || typeof candidate.workspacePath === "string")
    && (candidate.pid === undefined || (typeof candidate.pid === "number" && Number.isInteger(candidate.pid) && candidate.pid > 0))
    && (candidate.error === undefined || typeof candidate.error === "string");
}
