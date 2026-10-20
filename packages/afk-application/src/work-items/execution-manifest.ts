/**
 * The one grammar for the execution manifest.
 *
 * The manifest is the contract between the desktop client and the
 * execution runtime: the desktop writes it into the execution workspace,
 * the runtime reads it and runs the work item it names.  A manifest the
 * desktop accepts but the runtime refuses is a run that starts and then
 * dies, so both sides have to judge the same document the same way.
 *
 * They used to judge it with two grammars.  The desktop's copy checked
 * that a project key was a non-empty string; the runtime's copy checked
 * that it was a project key at all.  The runtime's answer is the right
 * one — it is the answer the tracker adapters and the identity grammar
 * already give — so the rules live here, once, and both sides use them.
 *
 * The shape and the rules are the same thing here: one declaration of
 * the manifest, one parser for it.
 */

import {
  parseWorkItemId,
  validateWorkItemPlatform,
  validateWorkItemProjectKey,
  type WorkItemPlatform,
} from './identity.js';
import { validateBaseBranch, validateCheckoutPath } from './run-paths.js';

export const EXECUTION_MANIFEST_SCHEMA_VERSION = 1;

/** The platform a repository in the manifest belongs to. */
export type ExecutionManifestPlatform = WorkItemPlatform;

export interface ExecutionManifestTracker {
  platform: ExecutionManifestPlatform;
  projectKey: string;
  providerHost?: string;
  providerProjectId?: string;
}

export interface ExecutionManifestRepository {
  platform: ExecutionManifestPlatform;
  projectKey: string;
  providerHost?: string;
  providerProjectId?: string;
  name: string;
  checkoutPath: string;
  baseBranch: string;
  role?: string;
  workingBranch: string;
  primary: boolean;
}

export interface ExecutionManifest {
  schemaVersion: 1;
  /**
   * The canonical work item id — "platform:projectKey#issueNumber".
   * Both runners parse it with the identity grammar before they act on
   * it, so a manifest that names anything else describes a run that
   * cannot happen.
   */
  workItemId: string;
  /** The provider's issue number for the same work item. */
  providerBacklogId: string;
  tracker: ExecutionManifestTracker;
  workingBranch: string;
  repositories: ExecutionManifestRepository[];
}

const MANIFEST_KEYS = new Set(['schemaVersion', 'workItemId', 'providerBacklogId', 'tracker', 'workingBranch', 'repositories']);
const TRACKER_KEYS = new Set(['platform', 'projectKey', 'providerHost', 'providerProjectId']);
const REPOSITORY_KEYS = new Set([
  'platform',
  'projectKey',
  'providerHost',
  'providerProjectId',
  'name',
  'checkoutPath',
  'baseBranch',
  'role',
  'workingBranch',
  'primary',
]);

type UnknownObject = { [key: string]: unknown };

/**
 * Read a manifest document.
 *
 * Every field is checked: an unknown field is a typo or a version this
 * reader does not know, and a manifest that carries one is not a manifest
 * this runtime can honour.
 */
export function parseExecutionManifestDocument(value: unknown): ExecutionManifest {
  const candidate = objectValue(value, 'manifest');
  assertExactKeys(candidate, MANIFEST_KEYS, 'manifest');
  if (candidate.schemaVersion !== EXECUTION_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`schemaVersion must be ${EXECUTION_MANIFEST_SCHEMA_VERSION}`);
  }

  const workItemId = canonicalWorkItemId(candidate.workItemId, 'workItemId');
  const providerBacklogId = positiveIntegerString(candidate.providerBacklogId, 'providerBacklogId');
  const tracker = parseTracker(candidate.tracker);
  const workingBranch = validateBaseBranch(candidate.workingBranch, 'workingBranch');
  if (!Array.isArray(candidate.repositories) || candidate.repositories.length === 0) {
    throw new Error('repositories must be a non-empty array');
  }

  const repositories = candidate.repositories.map((repository, index) => parseRepository(repository, index, workingBranch));
  const primaryCount = repositories.filter(repository => repository.primary).length;
  if (primaryCount !== 1) throw new Error('repositories must contain exactly one primary repository');
  assertUniqueRepositories(repositories);
  return { schemaVersion: EXECUTION_MANIFEST_SCHEMA_VERSION, workItemId, providerBacklogId, tracker, workingBranch, repositories };
}

function parseTracker(value: unknown): ExecutionManifestTracker {
  const candidate = objectValue(value, 'tracker');
  assertExactKeys(candidate, TRACKER_KEYS, 'tracker');
  return {
    platform: validateWorkItemPlatform(candidate.platform, 'tracker.platform'),
    projectKey: validateWorkItemProjectKey(candidate.projectKey, 'tracker.projectKey'),
    ...(candidate.providerHost === undefined ? {} : { providerHost: textValue(candidate.providerHost, 'tracker.providerHost', true) }),
    ...(candidate.providerProjectId === undefined ? {} : { providerProjectId: textValue(candidate.providerProjectId, 'tracker.providerProjectId') }),
  };
}

function parseRepository(value: unknown, index: number, workingBranch: string): ExecutionManifestRepository {
  const label = `repositories[${index}]`;
  const candidate = objectValue(value, label);
  assertExactKeys(candidate, REPOSITORY_KEYS, label);

  const repositoryWorkingBranch = validateBaseBranch(candidate.workingBranch, `${label}.workingBranch`);
  if (repositoryWorkingBranch !== workingBranch) throw new Error(`${label}.workingBranch must match workingBranch`);
  if (typeof candidate.primary !== 'boolean') throw new Error(`${label}.primary must be a boolean`);

  return {
    platform: validateWorkItemPlatform(candidate.platform, `${label}.platform`),
    projectKey: validateWorkItemProjectKey(candidate.projectKey, `${label}.projectKey`),
    ...(candidate.providerHost === undefined
      ? {}
      : { providerHost: textValue(candidate.providerHost, `${label}.providerHost`, true) }),
    ...(candidate.providerProjectId === undefined
      ? {}
      : { providerProjectId: textValue(candidate.providerProjectId, `${label}.providerProjectId`) }),
    name: textValue(candidate.name, `${label}.name`),
    checkoutPath: validateCheckoutPath(candidate.checkoutPath, `${label}.checkoutPath`),
    baseBranch: validateBaseBranch(candidate.baseBranch, `${label}.baseBranch`),
    ...(candidate.role === undefined ? {} : { role: textValue(candidate.role, `${label}.role`) }),
    workingBranch: repositoryWorkingBranch,
    primary: candidate.primary,
  };
}

function assertUniqueRepositories(repositories: readonly ExecutionManifestRepository[]): void {
  const identities = new Set<string>();
  const checkoutPaths = new Set<string>();
  for (const repository of repositories) {
    const identity = `${repository.platform}:${repository.projectKey}`;
    if (identities.has(identity)) throw new Error(`repositories contain duplicate repository: ${identity}`);
    const checkoutPath = repository.checkoutPath.replace(/[\\/]+/g, '/').toLowerCase();
    if (checkoutPaths.has(checkoutPath)) {
      throw new Error(`repositories contain duplicate checkoutPath: ${repository.checkoutPath}`);
    }
    identities.add(identity);
    checkoutPaths.add(checkoutPath);
  }
}

function canonicalWorkItemId(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a canonical work item id (platform:projectKey#issueNumber)`);
  }
  try {
    return parseWorkItemId(value).id;
  } catch (error) {
    throw new Error(`${label} must be a canonical work item id (platform:projectKey#issueNumber)`, { cause: error });
  }
}

function positiveIntegerString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${label} must be a positive integer string`);
  }
  return value;
}

function textValue(value: unknown, label: string, trimmed = false): string {
  if (
    typeof value !== 'string'
    || !value.trim()
    || /[\x00-\x1f\x7f]/.test(value)
    || (trimmed && value.trim() !== value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function objectValue(value: unknown, label: string): UnknownObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as UnknownObject;
}

function assertExactKeys(candidate: UnknownObject, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(candidate)) {
    if (!allowed.has(key)) throw new Error(`${label} has unknown field: ${key}`);
  }
}
