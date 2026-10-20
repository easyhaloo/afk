import type {
  BacklogPlatform,
  ProviderProjectRef,
  WorkItemRunRepositorySelection,
} from "./backlog-contract.js";

const BACKLOG_PLATFORM_VALUES: Record<BacklogPlatform, true> = {
  github: true,
  gitlab: true,
};
const SELECTION_KEYS = new Set(["platform", "projectKey", "providerHost", "providerProjectId", "name", "checkoutPath", "baseBranch", "role"]);

type RepositoryCheckoutPathSource = Pick<ProviderProjectRef, "name" | "projectKey"> & { checkoutPath?: string };

// The branch and checkout path rules live in the application package, next
// to the work item model they belong to; the execution manifest reader
// uses the same ones.
import { validateBaseBranch, validateCheckoutPath } from "@afk/application";

export { validateBaseBranch, validateCheckoutPath };

export function planRepositoryCheckoutPaths(repositories: readonly RepositoryCheckoutPathSource[]): string[] {
  const used = new Set<string>();
  return repositories.map((repository) => {
    const explicit = validRepositoryCheckoutPath(repository.checkoutPath);
    if (explicit && !used.has(checkoutPathKey(explicit))) {
      used.add(checkoutPathKey(explicit));
      return explicit;
    }
    const preferred = repository.name || repository.projectKey.split("/").at(-1) || "repository";
    const base = preferred
      .normalize("NFKC")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "") || "repository";
    let directory = base;
    let suffix = 2;
    while (used.has(checkoutPathKey(`repositories/${directory}`))) directory = `${base}-${suffix++}`;
    const checkoutPath = `repositories/${directory}`;
    used.add(checkoutPathKey(checkoutPath));
    return checkoutPath;
  });
}

export function repositorySelectionKey(selection: Pick<WorkItemRunRepositorySelection, "platform" | "projectKey">): string {
  return `${selection.platform}:${selection.projectKey}`;
}

export function defaultBaseBranch(repository: Pick<ProviderProjectRef, "defaultBranch">): string {
  return validateBaseBranch(repository.defaultBranch ?? "main", "defaultBranch");
}

export function validateRunRepositorySelectionSet(input: unknown): WorkItemRunRepositorySelection[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error("repositories must be a non-empty array");
  const selections = input.map((value, index) => parseSelection(value, index));
  const repositoryKeys = new Set<string>();
  const checkoutPaths = new Set<string>();
  for (const selection of selections) {
    const key = repositorySelectionKey(selection);
    if (repositoryKeys.has(key)) throw new Error(`repositories contain duplicate repository: ${key}`);
    const checkoutPath = checkoutPathKey(selection.checkoutPath);
    if (checkoutPaths.has(checkoutPath)) throw new Error(`repositories contain duplicate checkoutPath: ${selection.checkoutPath}`);
    repositoryKeys.add(key);
    checkoutPaths.add(checkoutPath);
  }
  return selections;
}

export function validateRunRepositorySelection(
  selected: readonly WorkItemRunRepositorySelection[],
  associated: readonly ProviderProjectRef[],
): WorkItemRunRepositorySelection[] {
  const selections = validateRunRepositorySelectionSet(selected);
  const associatedKeys = new Set(associated.map(repositorySelectionKey));
  for (const selection of selections) {
    const key = repositorySelectionKey(selection);
    if (!associatedKeys.has(key)) throw new Error(`repository ${key} is not associated with the work item`);
  }
  return selections;
}

function parseSelection(value: unknown, index: number): WorkItemRunRepositorySelection {
  const label = `repositories[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const candidate = value as Record<string, unknown>;
  for (const key of Object.keys(candidate)) if (!SELECTION_KEYS.has(key)) throw new Error(`${label} has unknown field: ${key}`);
  if (!isBacklogPlatform(candidate.platform)) throw new Error(`${label}: platform is invalid`);
  if (
    typeof candidate.projectKey !== "string"
    || !candidate.projectKey
    || candidate.projectKey.trim() !== candidate.projectKey
    || /[:#\s\x00-\x1f\x7f]/.test(candidate.projectKey)
    || candidate.projectKey.split("/").some(segment => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${label}: projectKey is invalid`);
  }
  return {
    platform: candidate.platform,
    projectKey: candidate.projectKey,
    ...(candidate.providerHost === undefined ? {} : { providerHost: validateText(candidate.providerHost, `${label}.providerHost`) }),
    ...(candidate.providerProjectId === undefined ? {} : { providerProjectId: validateText(candidate.providerProjectId, `${label}.providerProjectId`) }),
    name: validateText(candidate.name, `${label}.name`),
    checkoutPath: validateCheckoutPath(candidate.checkoutPath, `${label}.checkoutPath`),
    baseBranch: validateBaseBranch(candidate.baseBranch, `${label}.baseBranch`),
    ...(candidate.role === undefined ? {} : { role: validateText(candidate.role, `${label}.role`) }),
  };
}

function validateText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function validRepositoryCheckoutPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const checkoutPath = validateCheckoutPath(value).replace(/\\/g, "/");
    return checkoutPath.startsWith("repositories/") ? checkoutPath : undefined;
  } catch {
    return undefined;
  }
}

function checkoutPathKey(value: string): string {
  return value.replace(/[\\/]+/g, "/").toLowerCase();
}

function isBacklogPlatform(value: unknown): value is BacklogPlatform {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(BACKLOG_PLATFORM_VALUES, value);
}
