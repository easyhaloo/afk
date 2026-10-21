/**
 * Build one workspace package: clean its dist, then compile it.
 *
 * `tsc` overwrites the files it emits and leaves everything else alone, so
 * a module that moved keeps its old copy in dist/. The published package
 * then ships a file that points at a path that no longer exists - the
 * resource registry once did, and loading it failed with
 * ERR_MODULE_NOT_FOUND. The root's own build cleans its dist for the same
 * reason; the packages did not.
 *
 * Usage: node scripts/build-package.mjs <package-directory>
 */
import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = process.argv[2];
if (!packageDirectory) {
  console.error('usage: node scripts/build-package.mjs <package-directory>');
  process.exit(1);
}

rmSync(resolve(packageDirectory, 'dist'), { recursive: true, force: true });

// The repository's own tsc, so the script works outside a pnpm script
// context too.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const tsc = resolve(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');

const result = spawnSync(tsc, ['-p', 'tsconfig.json'], {
  cwd: packageDirectory,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);
