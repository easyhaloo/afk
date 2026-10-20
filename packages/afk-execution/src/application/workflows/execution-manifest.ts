import { readFile as readFileFromFs } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { isMissingFileError } from '@afk/application';
import {
  parseExecutionManifestDocument,
  type ExecutionManifest,
  type ExecutionManifestRepository,
  type ExecutionManifestTracker,
} from '@afk/application';

export type {
  ExecutionManifest,
  ExecutionManifestPlatform,
  ExecutionManifestRepository,
  ExecutionManifestTracker,
} from '@afk/application';

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
  /** The work item the caller asked for; the manifest has to name it. */
  workItemId: string;
}

export interface ReadExecutionManifestDependencies {
  cwd?: string;
  readFile?: (file: string, encoding: 'utf8') => Promise<string>;
}

/**
 * Read a manifest the caller already has in hand.
 *
 * The rules for what a manifest may say live in the application package,
 * next to the identity grammar they are made of — the desktop client
 * writes manifests through the same rules, so a document one side
 * accepts is a document the other side reads.
 */
export function parseExecutionManifest(value: unknown, options: ParseExecutionManifestOptions): ExecutionManifest {
  try {
    const manifest = parseExecutionManifestDocument(value);
    if (manifest.workItemId !== options.workItemId) {
      throw new Error(`workItemId must match the requested work item id ${options.workItemId}`);
    }
    return manifest;
  } catch (error) {
    throw manifestError(options.manifestPath, error);
  }
}

export async function readExecutionManifest(
  manifestPath: string,
  workItemId: string,
  dependencies: ReadExecutionManifestDependencies = {},
): Promise<ResolvedExecutionManifest> {
  const absoluteManifestPath = resolve(dependencies.cwd ?? process.cwd(), manifestPath);
  const readFile = dependencies.readFile ?? readFileFromFs;
  let raw: string;
  try {
    raw = await readFile(absoluteManifestPath, 'utf8');
  } catch (error) {
    const detail = isMissingFileError(error) ? 'file does not exist' : errorMessage(error);
    throw new Error(`Execution manifest at ${absoluteManifestPath}: ${detail}`, { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Execution manifest at ${absoluteManifestPath}: invalid JSON: ${errorMessage(error)}`, { cause: error });
  }

  const manifest = parseExecutionManifest(value, { manifestPath: absoluteManifestPath, workItemId });
  const manifestDirectory = dirname(absoluteManifestPath);
  const workspaceRoot = basename(manifestDirectory) === '.afk' ? dirname(manifestDirectory) : manifestDirectory;
  const repositories = manifest.repositories.map((repository, index) => ({
    ...repository,
    repoRoot: resolveRepositoryRoot(workspaceRoot, repository.checkoutPath, absoluteManifestPath, index),
  }));
  return { ...manifest, manifestPath: absoluteManifestPath, workspaceRoot, repositories };
}

function resolveRepositoryRoot(workspaceRoot: string, checkoutPath: string, manifestPath: string, index: number): string {
  const repoRoot = resolve(workspaceRoot, checkoutPath.replace(/\\/g, '/'));
  const relativePath = relative(workspaceRoot, repoRoot);
  if (relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativePath)) {
    throw new Error(`Execution manifest at ${manifestPath}: repositories[${index}].checkoutPath escapes the execution workspace`);
  }
  return repoRoot;
}

function manifestError(manifestPath: string, error: unknown): Error {
  return new Error(`Invalid execution manifest at ${manifestPath}: ${errorMessage(error)}`, { cause: error });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
