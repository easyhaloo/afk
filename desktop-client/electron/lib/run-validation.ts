/**
 * Runtime validators for work-item-run execution inputs.
 * These are Electron-main-process business-logic validators that were
 * incorrectly placed in shared/ alongside wire-format parsers.
 */

import type { ProviderProjectRef, WorkItemRunRepositorySelection } from "../../shared/backlog-contract";

const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const CONTROL_CHARACTER_PATTERN = /[\x00-\x1f\x7f]/;

export function validateBaseBranch(value: unknown, label = "baseBranch"): string {
  if (typeof value !== "string" || !value || CONTROL_CHARACTER_PATTERN.test(value) || value.includes("..") || value.endsWith("/") || !BRANCH_PATTERN.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function validateCheckoutPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || CONTROL_CHARACTER_PATTERN.test(value) || value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value) || value.split(/[\\/]/).some(segment => segment === "..")) {
    throw new Error("checkoutPath is invalid");
  }
  return value;
}

export function repositorySelectionKey(value: Pick<WorkItemRunRepositorySelection, "platform" | "projectKey">): string {
  return `${value.platform}:${value.projectKey}`;
}

export function defaultBaseBranch(repository: Pick<ProviderProjectRef, "defaultBranch">): string {
  return repository.defaultBranch || "main";
}

export function validateRunRepositorySelectionSet(selected: readonly WorkItemRunRepositorySelection[]): WorkItemRunRepositorySelection[] {
  if (selected.length === 0) throw new Error("at least one repository must be selected");

  const selectedKeys = new Set<string>();
  return selected.map((repository) => {
    const key = repositorySelectionKey(repository);
    if (selectedKeys.has(key)) throw new Error(`duplicate repository selection: ${key}`);
    selectedKeys.add(key);
    return {
      ...repository,
      checkoutPath: validateCheckoutPath(repository.checkoutPath),
      baseBranch: validateBaseBranch(repository.baseBranch),
    };
  });
}
