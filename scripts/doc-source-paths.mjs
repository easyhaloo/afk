/**
 * Which backticked paths in a document are claims about source.
 *
 * A document that names a source file makes a claim that the file exists:
 * moving a module without correcting the documents that name it leaves a
 * claim nobody is checking. That claim is worth making — but only about
 * source.
 *
 * Build output is not source. `dist/`, `dist-electron/` and `release/` hold
 * generated artifacts, and a document may legitimately name the artifact a
 * build produces. That file does not exist until the build runs, so
 * demanding it would fail the check on a clean checkout and pass only on a
 * machine that happened to build first.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const GENERATED_OUTPUT_ROOTS = ['dist', 'dist-electron', 'release'];

/**
 * Whether a path names a generated artifact rather than a source file.
 *
 * The root may appear anywhere in the path, because a document may name the
 * artifact relative to the repository root or to the desktop client.
 */
export function isGeneratedOutputPath(raw) {
  return raw.split('/').some((segment) => GENERATED_OUTPUT_ROOTS.includes(segment));
}

/**
 * The roots a document may name a source path relative to.
 *
 * A document lives in the repository, so it may name a path relative to its
 * own directory, to the repository root, or relative to one of the two
 * applications' source trees.
 */
export function sourcePathCandidates(repoRoot, fileDir, raw) {
  return [
    join(fileDir, raw),
    join(repoRoot, raw),
    join(repoRoot, 'apps', 'desktop', raw),
    join(repoRoot, 'apps', 'desktop', 'src', raw),
    join(repoRoot, 'apps', 'cli', raw),
    join(repoRoot, 'apps', 'cli', 'src', raw),
  ];
}

/**
 * Whether a backticked path names a file that exists.
 *
 * `null` means the path is not a claim about source at all: a bare file name
 * with no directory cannot be resolved with any confidence, and a path under a
 * generated-output directory is describing an artifact rather than a source.
 */
export function isExistingSourcePath(repoRoot, fileDir, raw) {
  if (!raw.includes('/')) return null;
  if (/[*<>]|\$\{/.test(raw)) return null;
  if (isGeneratedOutputPath(raw)) return null;
  const candidates = sourcePathCandidates(repoRoot, fileDir, raw);
  return candidates.some(candidate => existsSync(candidate));
}
