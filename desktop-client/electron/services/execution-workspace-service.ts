import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderProjectRef, WorkItemId } from "../../shared/backlog-contract";
import { parseWorkItemId } from "../../shared/backlog-contract";

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
  return path.join(os.homedir(), ".loop-workspace");
}

function taskDirectoryName(taskId: WorkItemId): string {
  const canonical = normalizeTaskId(taskId);
  const segments = canonical.split(/[:/#]+/).filter(Boolean);
  if (!segments.length) throw new Error("task ID produces an invalid workspace directory");
  const segmentPattern = /^[A-Za-z0-9._-]+$/;
  for (const segment of segments) {
    if (segment === "." || segment === ".." || !segmentPattern.test(segment)) {
      throw new Error(`task ID produces an invalid workspace segment: ${segment}`);
    }
  }
  return segments.join(path.sep);
}

function normalizeTaskId(taskId: WorkItemId): WorkItemId {
  if (typeof taskId !== "string" || taskId.trim() !== taskId || taskId.length > 160) throw new Error("task ID is invalid");
  try {
    return parseWorkItemId(taskId);
  } catch {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(taskId) || taskId.includes("..")) throw new Error("task ID is invalid");
    return taskId;
  }
}

function repositoryDirectoryNames(projects: readonly ProviderProjectRef[]): string[] {
  const used = new Set<string>();
  return projects.map((project) => {
    const preferred = project.name || project.projectKey.split("/").at(-1) || "repository";
    const base = preferred
      .normalize("NFKC")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "") || "repository";
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${base}-${suffix++}`;
    used.add(candidate);
    return candidate;
  });
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

  async function allocate(taskId: WorkItemId, projects: readonly ProviderProjectRef[] = []): Promise<ExecutionWorkspaceMetadata> {
    const canonicalTaskId = normalizeTaskId(taskId);
    const root = rootFor(canonicalTaskId);
    const repositoriesRoot = path.join(root, "repositories");
    const directoryNames = repositoryDirectoryNames(projects);
    const repositories = projects.map((project, index) => ({
      project,
      path: path.join(repositoriesRoot, directoryNames[index]),
    }));
    const artifacts = path.join(root, "artifacts");
    const runtime = path.join(root, "runtime");
    const logs = path.join(root, "logs");
    const diagnostics = path.join(root, "diagnostics");
    const metadataFile = metadataPath(root);

    await mkdir(baseDirectory, { recursive: true });
    await mkdir(repositoriesRoot, { recursive: true });
    await Promise.all(repositories.map(repository => mkdir(repository.path, { recursive: true })));
    await mkdir(artifacts, { recursive: true });
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
