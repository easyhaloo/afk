import { randomUUID as createRandomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  parseWorkItemRunStartInput,
  type WorkItemId,
  type ProviderProjectRef,
  type WorkItemRunRepositorySelection,
} from "../../shared/backlog-contract";
import {
  validateBaseBranch,
  validateRunRepositorySelectionSet,
} from "../../shared/work-item-run-validation";

const MANIFEST_FILE = "execution-manifest.json";
const MANIFEST_SCHEMA_VERSION = 1;
const MANIFEST_KEYS = new Set(["schemaVersion", "workItemId", "providerBacklogId", "tracker", "workingBranch", "repositories"]);
const TRACKER_KEYS = new Set(["platform", "projectKey", "providerHost", "providerProjectId"]);
const REPOSITORY_KEYS = new Set([
  "platform",
  "projectKey",
  "providerHost",
  "providerProjectId",
  "name",
  "checkoutPath",
  "baseBranch",
  "role",
  "workingBranch",
  "primary",
]);

export type WorkItemExecutionManifestRepository = WorkItemRunRepositorySelection & {
  workingBranch: string;
  primary: boolean;
};

export type WorkItemExecutionManifest = {
  schemaVersion: 1;
  workItemId: WorkItemId;
  providerBacklogId: string;
  tracker: Pick<ProviderProjectRef, "platform" | "projectKey" | "providerHost" | "providerProjectId">;
  workingBranch: string;
  repositories: WorkItemExecutionManifestRepository[];
};

export type WorkItemExecutionManifestStoreFs = {
  mkdir: (directory: string, options: { recursive: true }) => Promise<unknown>;
  readFile: (file: string, encoding: "utf8") => Promise<string>;
  writeFile: (file: string, data: string, options: { encoding: "utf8"; mode: number }) => Promise<unknown>;
  rename: (source: string, target: string) => Promise<unknown>;
  unlink: (file: string) => Promise<unknown>;
};

export type WorkItemExecutionManifestStoreDeps = {
  fs?: WorkItemExecutionManifestStoreFs;
  randomUUID?: () => string;
};

const defaultFs: WorkItemExecutionManifestStoreFs = {
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
};

export function createWorkItemExecutionManifestStore(deps: WorkItemExecutionManifestStoreDeps = {}) {
  const fs = deps.fs ?? defaultFs;
  const randomUUID = deps.randomUUID ?? createRandomUUID;

  async function load(workspace: string): Promise<WorkItemExecutionManifest | null> {
    const target = workItemExecutionManifestPath(workspace);
    let raw: string;
    try {
      raw = await fs.readFile(target, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw withPath(`Failed to read execution manifest`, target, error);
    }
    try {
      return parseManifest(JSON.parse(raw));
    } catch (error) {
      throw withPath(`Invalid execution manifest`, target, error);
    }
  }

  async function save(workspace: string, value: WorkItemExecutionManifest): Promise<void> {
    const target = workItemExecutionManifestPath(workspace);
    let temporary: string | undefined;
    try {
      const manifest = parseManifest(value);
      temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, target);
    } catch (error) {
      if (temporary) await fs.unlink(temporary).catch(() => undefined);
      throw withPath("Failed to save execution manifest", target, error);
    }
  }

  return { load, save };
}

export function workItemExecutionManifestPath(workspace: string): string {
  return path.join(workspace, ".afk", MANIFEST_FILE);
}

function parseManifest(value: unknown): WorkItemExecutionManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("manifest must be an object");
  const candidate = value as Record<string, unknown>;
  assertExactKeys(candidate, MANIFEST_KEYS, "manifest");
  if (candidate.schemaVersion !== MANIFEST_SCHEMA_VERSION) throw new Error(`schemaVersion must be ${MANIFEST_SCHEMA_VERSION}`);
  if (!Array.isArray(candidate.repositories) || candidate.repositories.length === 0) throw new Error("repositories must be a non-empty array");

  const workingBranch = validateBaseBranch(candidate.workingBranch, "workingBranch");
  const providerBacklogId = parseProviderBacklogId(candidate.providerBacklogId);
  const tracker = parseTracker(candidate.tracker);
  const repositoryCandidates = candidate.repositories.map((repository, index) => parseRepositoryCandidate(repository, index));
  const selections = validateRunRepositorySelectionSet(repositoryCandidates.map(repository => repository.selection));
  const repositories = selections.map((selection, index): WorkItemExecutionManifestRepository => {
    const repository = repositoryCandidates[index];
    if (repository.workingBranch !== workingBranch) throw new Error(`repositories[${index}].workingBranch must match workingBranch`);
    return { ...selection, workingBranch: repository.workingBranch, primary: repository.primary };
  });
  if (repositories.filter(repository => repository.primary).length !== 1) throw new Error("repositories must contain exactly one primary repository");

  const workItemId = parseWorkItemRunStartInput({ workItemId: candidate.workItemId, repositories: selections }).workItemId;
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    workItemId,
    providerBacklogId,
    tracker,
    workingBranch,
    repositories,
  };
}

function parseTracker(value: unknown): WorkItemExecutionManifest["tracker"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("tracker must be an object");
  const candidate = value as Record<string, unknown>;
  assertExactKeys(candidate, TRACKER_KEYS, "tracker");
  if (candidate.platform !== "github" && candidate.platform !== "gitlab") throw new Error("tracker.platform is invalid");
  if (typeof candidate.projectKey !== "string" || !candidate.projectKey.trim()) throw new Error("tracker.projectKey is invalid");
  for (const key of ["providerHost", "providerProjectId"] as const) {
    if (candidate[key] !== undefined && (typeof candidate[key] !== "string" || !candidate[key].trim())) throw new Error(`tracker.${key} is invalid`);
  }
  return {
    platform: candidate.platform,
    projectKey: candidate.projectKey,
    ...(candidate.providerHost === undefined ? {} : { providerHost: candidate.providerHost as string }),
    ...(candidate.providerProjectId === undefined ? {} : { providerProjectId: candidate.providerProjectId as string }),
  };
}

function parseRepositoryCandidate(value: unknown, index: number): {
  selection: Record<string, unknown>;
  workingBranch: string;
  primary: boolean;
} {
  const label = `repositories[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const candidate = value as Record<string, unknown>;
  assertExactKeys(candidate, REPOSITORY_KEYS, label);
  if (typeof candidate.primary !== "boolean") throw new Error(`${label}.primary must be a boolean`);
  const selection: Record<string, unknown> = {
    platform: candidate.platform,
    projectKey: candidate.projectKey,
    name: candidate.name,
    checkoutPath: candidate.checkoutPath,
    baseBranch: candidate.baseBranch,
  };
  for (const key of ["providerHost", "providerProjectId", "role"] as const) {
    if (candidate[key] !== undefined) selection[key] = candidate[key];
  }
  return {
    selection,
    workingBranch: validateBaseBranch(candidate.workingBranch, `${label}.workingBranch`),
    primary: candidate.primary,
  };
}

function assertExactKeys(candidate: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(candidate)) if (!allowed.has(key)) throw new Error(`${label} has unknown field: ${key}`);
}

function parseProviderBacklogId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("providerBacklogId must be a positive integer string");
  }
  return value;
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function withPath(prefix: string, file: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`${prefix} at ${file}: ${detail}`, { cause: error });
}
