import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ProviderProjectRef, WorkItemId } from "../../shared/backlog-contract.js";
import { planRepositoryCheckoutPaths } from "../../shared/work-item-run-validation.js";
import { executionWorkspacePath, resolveWorkspaceRoot, workspaceDataDirectory } from "@afk/runtime/infrastructure/workspace";

export type ExecutionWorkspaceRepository = {
  project: ProviderProjectRef;
  path: string;
};

export type ExecutionWorkspaceMetadata = {
  taskId: WorkItemId;
  root: string;
  repositoriesRoot: string;
  repositories: ExecutionWorkspaceRepository[];
  artifacts: string;
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
  return resolveWorkspaceRoot();
}

function metadataPath(root: string): string {
  return path.join(workspaceDataDirectory(root), "workspace.json");
}

const metadataWrites = new Map<string, Promise<void>>();

async function withMetadataWrite<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const previous = metadataWrites.get(file) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  metadataWrites.set(file, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (metadataWrites.get(file) === current) metadataWrites.delete(file);
  }
}

async function writeMetadata(file: string, metadata: ExecutionWorkspaceMetadata): Promise<void> {
  const temporaryFile = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryFile, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryFile, file);
  } finally {
    await rm(temporaryFile, { force: true });
  }
}

export function createExecutionWorkspaceService(options: ExecutionWorkspaceServiceOptions = {}) {
  const baseDirectory = path.resolve(options.baseDirectory ?? defaultBaseDirectory());
  const now = options.now ?? (() => new Date());

  function rootFor(taskId: WorkItemId): string {
    return executionWorkspacePath(taskId, baseDirectory);
  }

  async function allocate(taskId: WorkItemId, projects: readonly (ProviderProjectRef & { checkoutPath?: string })[] = []): Promise<ExecutionWorkspaceMetadata> {
    const canonicalTaskId = taskId;
    const root = rootFor(canonicalTaskId);
    const repositoriesRoot = path.join(root, "repositories");
    const checkoutPaths = planRepositoryCheckoutPaths(projects);
    const repositories = projects.map((project, index) => ({
      project,
      path: path.join(root, ...checkoutPaths[index].split("/")),
    }));
    const artifacts = path.join(root, "artifacts");
    const runtime = path.join(workspaceDataDirectory(root), "runtime");
    const logs = path.join(workspaceDataDirectory(root), "logs");
    const diagnostics = path.join(workspaceDataDirectory(root), "diagnostics");
    const metadataFile = metadataPath(root);

    await mkdir(baseDirectory, { recursive: true });
    await mkdir(path.dirname(metadataFile), { recursive: true });
    await mkdir(repositoriesRoot, { recursive: true });
    await Promise.all(repositories.map(repository => mkdir(repository.path, { recursive: true })));
    await mkdir(artifacts, { recursive: true });
    await mkdir(runtime, { recursive: true });
    await mkdir(logs, { recursive: true });
    await mkdir(diagnostics, { recursive: true });

    return withMetadataWrite(metadataFile, async () => {
      const existing = await read(canonicalTaskId);
      if (existing) {
        if (existing.taskId !== canonicalTaskId) throw new Error(`workspace metadata does not match ${canonicalTaskId}`);
        const next = { ...existing, repositories };
        await writeMetadata(metadataFile, next);
        return next;
      }

      const metadata: ExecutionWorkspaceMetadata = {
        taskId: canonicalTaskId,
        root,
        repositoriesRoot,
        repositories,
        artifacts,
        runtime,
        logs,
        diagnostics,
        createdAt: now().toISOString(),
        cleanupStatus: "active",
      };
      await writeMetadata(metadataFile, metadata);
      return metadata;
    });
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

  async function updateRun(taskId: WorkItemId, runId: string | undefined, expectedCurrentRunId?: string): Promise<ExecutionWorkspaceMetadata> {
    return withMetadataWrite(metadataPath(rootFor(taskId)), async () => {
      const current = await read(taskId);
      if (!current) throw new Error(`execution workspace does not exist for ${taskId}`);
      if (expectedCurrentRunId !== undefined && current.currentRunId !== expectedCurrentRunId) return current;
      const next = { ...current, ...(runId ? { currentRunId: runId } : { currentRunId: undefined }) };
      await writeMetadata(metadataPath(current.root), next);
      return next;
    });
  }

  async function markCleaned(taskId: WorkItemId): Promise<ExecutionWorkspaceMetadata> {
    return withMetadataWrite(metadataPath(rootFor(taskId)), async () => {
      const current = await read(taskId);
      if (!current) throw new Error(`execution workspace does not exist for ${taskId}`);
      const next = { ...current, cleanupStatus: "cleaned" as const };
      await writeMetadata(metadataPath(current.root), next);
      return next;
    });
  }

  return { baseDirectory, allocate, read, updateRun, markCleaned };
}
