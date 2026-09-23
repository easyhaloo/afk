import { readFile as readFileFromFs } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

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
const WINDOWS_RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

type UnknownObject = { [key: string]: unknown };

export type ExecutionManifestPlatform = 'github' | 'gitlab';

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
  workItemId: string;
  providerBacklogId: string;
  tracker: ExecutionManifestTracker;
  workingBranch: string;
  repositories: ExecutionManifestRepository[];
}

export interface ResolvedExecutionManifestRepository extends ExecutionManifestRepository {
  repoRoot: string;
}

export interface ResolvedExecutionManifest extends Omit<ExecutionManifest, 'repositories'> {
  manifestPath: string;
  workspaceRoot: string;
  repositories: ResolvedExecutionManifestRepository[];
}

export interface ParseExecutionManifestOptions {
  manifestPath: string;
  backlogId: string;
}

export interface ReadExecutionManifestDependencies {
  cwd?: string;
  readFile?: (file: string, encoding: 'utf8') => Promise<string>;
}

export function parseExecutionManifest(value: unknown, options: ParseExecutionManifestOptions): ExecutionManifest {
  try {
    return parseManifest(value, options.backlogId);
  } catch (error) {
    throw manifestError(options.manifestPath, error);
  }
}

export async function readExecutionManifest(
  manifestPath: string,
  backlogId: string,
  dependencies: ReadExecutionManifestDependencies = {},
): Promise<ResolvedExecutionManifest> {
  const absoluteManifestPath = resolve(dependencies.cwd ?? process.cwd(), manifestPath);
  const readFile = dependencies.readFile ?? readFileFromFs;
  let raw: string;
  try {
    raw = await readFile(absoluteManifestPath, 'utf8');
  } catch (error) {
    const detail = isMissingFile(error) ? 'file does not exist' : errorMessage(error);
    throw new Error(`Execution manifest at ${absoluteManifestPath}: ${detail}`, { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Execution manifest at ${absoluteManifestPath}: invalid JSON: ${errorMessage(error)}`, { cause: error });
  }

  const manifest = parseExecutionManifest(value, { manifestPath: absoluteManifestPath, backlogId });
  const manifestDirectory = dirname(absoluteManifestPath);
  const workspaceRoot = basename(manifestDirectory) === '.afk' ? dirname(manifestDirectory) : manifestDirectory;
  const repositories = manifest.repositories.map((repository, index) => ({
    ...repository,
    repoRoot: resolveRepositoryRoot(workspaceRoot, repository.checkoutPath, absoluteManifestPath, index),
  }));
  return { ...manifest, manifestPath: absoluteManifestPath, workspaceRoot, repositories };
}

function parseManifest(value: unknown, backlogId: string): ExecutionManifest {
  const candidate = objectValue(value, 'manifest');
  assertExactKeys(candidate, MANIFEST_KEYS, 'manifest');
  if (candidate.schemaVersion !== 1) throw new Error('schemaVersion must be 1');
  const workItemId = textValue(candidate.workItemId, 'workItemId', true);
  if (workItemId !== backlogId) throw new Error(`workItemId must match --backlog-id ${backlogId}`);
  const providerBacklogId = positiveIntegerString(candidate.providerBacklogId, 'providerBacklogId');
  const tracker = parseTracker(candidate.tracker);
  const workingBranch = branchValue(candidate.workingBranch, 'workingBranch');
  if (!Array.isArray(candidate.repositories) || candidate.repositories.length === 0) {
    throw new Error('repositories must be a non-empty array');
  }

  const repositories = candidate.repositories.map((repository, index) => parseRepository(repository, index, workingBranch));
  const primaryCount = repositories.filter(repository => repository.primary).length;
  if (primaryCount !== 1) throw new Error('repositories must contain exactly one primary repository');
  assertUniqueRepositories(repositories);
  return { schemaVersion: 1, workItemId, providerBacklogId, tracker, workingBranch, repositories };
}

function parseTracker(value: unknown): ExecutionManifestTracker {
  const candidate = objectValue(value, 'tracker');
  assertExactKeys(candidate, TRACKER_KEYS, 'tracker');
  if (candidate.platform !== 'github' && candidate.platform !== 'gitlab') throw new Error('tracker.platform must be github or gitlab');
  return {
    platform: candidate.platform,
    projectKey: projectKeyValue(candidate.projectKey, 'tracker.projectKey'),
    ...(candidate.providerHost === undefined ? {} : { providerHost: textValue(candidate.providerHost, 'tracker.providerHost', true) }),
    ...(candidate.providerProjectId === undefined ? {} : { providerProjectId: textValue(candidate.providerProjectId, 'tracker.providerProjectId') }),
  };
}

function parseRepository(value: unknown, index: number, workingBranch: string): ExecutionManifestRepository {
  const label = `repositories[${index}]`;
  const candidate = objectValue(value, label);
  assertExactKeys(candidate, REPOSITORY_KEYS, label);
  const repositoryWorkingBranch = branchValue(candidate.workingBranch, `${label}.workingBranch`);
  if (repositoryWorkingBranch !== workingBranch) throw new Error(`${label}.workingBranch must match workingBranch`);
  if (typeof candidate.primary !== 'boolean') throw new Error(`${label}.primary must be a boolean`);
  const platform = candidate.platform;
  if (platform !== 'github' && platform !== 'gitlab') throw new Error(`${label}.platform must be github or gitlab`);

  return {
    platform,
    projectKey: projectKeyValue(candidate.projectKey, `${label}.projectKey`),
    ...(candidate.providerHost === undefined
      ? {}
      : { providerHost: textValue(candidate.providerHost, `${label}.providerHost`, true) }),
    ...(candidate.providerProjectId === undefined
      ? {}
      : { providerProjectId: textValue(candidate.providerProjectId, `${label}.providerProjectId`) }),
    name: textValue(candidate.name, `${label}.name`),
    checkoutPath: checkoutPathValue(candidate.checkoutPath, `${label}.checkoutPath`),
    baseBranch: branchValue(candidate.baseBranch, `${label}.baseBranch`),
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

function resolveRepositoryRoot(workspaceRoot: string, checkoutPath: string, manifestPath: string, index: number): string {
  const repoRoot = resolve(workspaceRoot, checkoutPath.replace(/\\/g, '/'));
  const relativePath = relative(workspaceRoot, repoRoot);
  if (relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativePath)) {
    throw new Error(`Execution manifest at ${manifestPath}: repositories[${index}].checkoutPath escapes the execution workspace`);
  }
  return repoRoot;
}

function checkoutPathValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  if (/^[A-Za-z]:/.test(value)) throw new Error(`${label} must not use a drive prefix`);
  if (value.startsWith('/') || value.startsWith('\\')) throw new Error(`${label} must be relative`);
  if (value.endsWith('/') || value.endsWith('\\')) throw new Error(`${label} must not end with a separator`);
  const segments = value.replace(/\\/g, '/').split('/');
  if (segments.some(segment => segment === '.' || segment === '..')) throw new Error(`${label} must not traverse directories`);
  if (segments.some(segment => segment.endsWith('.') || segment.endsWith(' '))) {
    throw new Error(`${label} has a non-portable path segment`);
  }
  if (segments.some(segment => /[<>:"|?*]/.test(segment))) throw new Error(`${label} contains an invalid Windows path character`);
  if (segments.some(segment => WINDOWS_RESERVED_DEVICE_NAME.test(segment))) {
    throw new Error(`${label} uses a reserved Windows device name`);
  }
  return value;
}

function branchValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) throw new Error(`${label} is invalid`);
  const segments = value.split('/');
  if (
    value === '@'
    || value.includes('..')
    || value.includes('@{')
    || value.includes('//')
    || /[\\ ~^:?*[\x00-\x1f\x7f]/.test(value)
    || segments.some(segment => !segment || segment.startsWith('.') || segment.endsWith('.') || segment.endsWith('.lock'))
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function projectKeyValue(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || !value
    || value.trim() !== value
    || /[:#\s\x00-\x1f\x7f]/.test(value)
    || value.split('/').some(segment => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`${label} is invalid`);
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

function positiveIntegerString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${label} must be a positive integer string`);
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

function manifestError(manifestPath: string, error: unknown): Error {
  return new Error(`Invalid execution manifest at ${manifestPath}: ${errorMessage(error)}`, { cause: error });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}
