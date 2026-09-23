import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { parseWorkItemRunRecord, type WorkItemRunRecord } from "../../shared/backlog-contract";

const RUN_STORE_FILE = "work-item-runs.json";

export type WorkItemRunStoreDeps = {
  resolveWorkspace: (input: string) => string;
};

export function createWorkItemRunStore(deps: WorkItemRunStoreDeps) {
  const writes = new Map<string, Promise<void>>();

  function filePath(workspace: string): string {
    return path.join(deps.resolveWorkspace(workspace), ".afk", RUN_STORE_FILE);
  }

  function serialize<T>(target: string, operation: () => Promise<T>): Promise<T> {
    const previous = writes.get(target) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(() => undefined, () => undefined);
    writes.set(target, settled);
    void settled.then(() => {
      if (writes.get(target) === settled) writes.delete(target);
    });
    return result;
  }

  async function load(workspace: string): Promise<WorkItemRunRecord[]> {
    const raw = await readFile(filePath(workspace), "utf8").catch(() => "");
    if (!raw.trim()) return [];
    try {
      const value = JSON.parse(raw) as unknown;
      if (!Array.isArray(value)) return [];
      const runs: WorkItemRunRecord[] = [];
      for (const item of value) {
        try {
          runs.push(parseWorkItemRunRecord(item));
        } catch {
          continue;
        }
      }
      return runs;
    } catch {
      return [];
    }
  }

  async function write(target: string, runs: WorkItemRunRecord[]): Promise<void> {
    const directory = path.dirname(target);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, JSON.stringify(runs, null, 2), "utf8");
    await rename(temporary, target);
  }

  function save(workspace: string, runs: WorkItemRunRecord[]): Promise<void> {
    const target = filePath(workspace);
    return serialize(target, async () => {
      const current = await load(workspace);
      const currentById = new Map(current.map(run => [run.id, run]));
      const incomingIds = new Set(runs.map(run => run.id));
      await write(target, [
        ...runs.map(run => {
          const persisted = currentById.get(run.id);
          if (persisted?.status === "completed" || persisted?.status === "failed") return persisted;
          if (persisted?.status === "running" && persisted.pid !== undefined && run.pid === undefined) return persisted;
          return run;
        }),
        ...current.filter(run => !incomingIds.has(run.id)),
      ]);
    });
  }

  function update(
    workspace: string,
    transform: (runs: WorkItemRunRecord[]) => WorkItemRunRecord[] | undefined | Promise<WorkItemRunRecord[] | undefined>,
  ): Promise<void> {
    const target = filePath(workspace);
    return serialize(target, async () => {
      const next = await transform(await load(workspace));
      if (next) await write(target, next);
    });
  }

  return { load, save, update };
}
