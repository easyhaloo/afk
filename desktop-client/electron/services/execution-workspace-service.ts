import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderProjectRef, WorkItemId } from "../../shared/backlog-contract";
import { parseWorkItemId } from "../../shared/backlog-contract";

export type ExecutionWorkspaceMetadata = {
  taskId: WorkItemId;
  sourceProject: ProviderProjectRef;
  root: string;
  checkout: string;
  runtime: string;
  logs: string;
  diagnostics: string;
  createdAt: string;
  currentRunId?: string;
  cleanupStatus: "active" | "cleaned";
};

export type ExecutionWorkspaceServiceOptions = {
  baseDirectory?: string;
  now?: () => Date;
};

function defaultBaseDirectory(): string {
  return path.join(os.homedir(), ".loop-workspace");
}

function taskDirectoryName(taskId: WorkItemId): string {
  const canonical = parseWorkItemId(taskId);
  const encoded = encodeURIComponent(canonical);
  if (!encoded || encoded === "." || encoded === "..") throw new Error("task ID produces an invalid workspace directory");
  return encoded;
}

function metadataPath(root: string): string {
  return path.join(root, "workspace.json");
}

export function createExecutionWorkspaceService(options: ExecutionWorkspaceServiceOptions = {}) {
  const baseDirectory = path.resolve(options.baseDirectory ?? defaultBaseDirectory());
  const now = options.now ?? (() => new Date());

  function rootFor(taskId: WorkItemId): string {
    return path.join(baseDirectory, taskDirectoryName(taskId));
  }

  async function allocate(taskId: WorkItemId, sourceProject: ProviderProjectRef): Promise<ExecutionWorkspaceMetadata> {
    const canonicalTaskId = parseWorkItemId(taskId);
    const root = rootFor(canonicalTaskId);
    const checkout = path.join(root, "checkout");
    const runtime = path.join(root, "runtime");
    const logs = path.join(root, "logs");
    const diagnostics = path.join(root, "diagnostics");
    const metadataFile = metadataPath(root);

    await mkdir(baseDirectory, { recursive: true });
    await mkdir(checkout, { recursive: true });
    await mkdir(runtime, { recursive: true });
    await mkdir(logs, { recursive: true });
    await mkdir(diagnostics, { recursive: true });

    try {
      const existing = JSON.parse(await readFile(metadataFile, "utf8")) as ExecutionWorkspaceMetadata;
      if (existing.taskId !== canonicalTaskId) throw new Error(`workspace metadata does not match ${canonicalTaskId}`);
      return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof SyntaxError) throw new Error(`workspace metadata is invalid: ${metadataFile}`);
        throw error;
      }
    }

    const metadata: ExecutionWorkspaceMetadata = {
      taskId: canonicalTaskId,
      sourceProject,
      root,
      checkout,
      runtime,
      logs,
      diagnostics,
      createdAt: now().toISOString(),
      cleanupStatus: "active",
    };
    await writeFile(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    return JSON.parse(await readFile(metadataFile, "utf8")) as ExecutionWorkspaceMetadata;
  }

  async function read(taskId: WorkItemId): Promise<ExecutionWorkspaceMetadata | null> {
    const file = metadataPath(rootFor(taskId));
    try {
      return JSON.parse(await readFile(file, "utf8")) as ExecutionWorkspaceMetadata;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof SyntaxError) throw new Error(`workspace metadata is invalid: ${file}`);
      throw error;
    }
  }

  async function updateRun(taskId: WorkItemId, runId: string | undefined): Promise<ExecutionWorkspaceMetadata> {
    const current = await read(taskId);
    if (!current) throw new Error(`execution workspace does not exist for ${taskId}`);
    const next = { ...current, ...(runId ? { currentRunId: runId } : { currentRunId: undefined }) };
    await writeFile(metadataPath(current.root), `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return next;
  }

  async function markCleaned(taskId: WorkItemId): Promise<ExecutionWorkspaceMetadata> {
    const current = await read(taskId);
    if (!current) throw new Error(`execution workspace does not exist for ${taskId}`);
    const next = { ...current, cleanupStatus: "cleaned" as const };
    await writeFile(metadataPath(current.root), `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return next;
  }

  return { baseDirectory, allocate, read, updateRun, markCleaned };
}
