/**
 * What a package's build was made from.
 *
 * A package's `dist/` is what the rest of the workspace loads, so a dist
 * built from older sources is a dist that answers for code that is no
 * longer there. The build records the sources it compiled, and the
 * freshness check compares that record with the sources on disk: a
 * mismatch means the built output is not the current source, and a test
 * that runs against it is a test of something else.
 *
 * The comparison is by content, not by timestamp. A file that was touched
 * without being changed - a branch switch, a formatter - moves its
 * timestamp and would look stale; its content did not move.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/** The file, inside dist/, that records what the build was made from. */
export const BUILD_STAMP_FILE = '.afk-build-sources.json';

/** Every source file of a package, as paths relative to the package root. */
export function sourceFiles(packageDirectory) {
  const files = [];
  const visit = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !isNotBuilt(entry.name)) {
        files.push(relative(packageDirectory, full).split(sep).join('/'));
      }
    }
  };
  visit(resolve(packageDirectory, 'src'));
  return files.sort();
}

/**
 * The sources that do not go into the build.
 *
 * A test file and a declaration file are not compiled into the output, so
 * a change to one of them does not make the output stale - and a check
 * that said otherwise would send people to rebuild for nothing.
 */
function isNotBuilt(fileName) {
  return /\.(test|spec)\.tsx?$/.test(fileName) || /\.d\.ts$/.test(fileName);
}

/** The sources a build was made from, and their content hashes. */
export function buildSources(packageDirectory) {
  const files = {};
  for (const file of sourceFiles(packageDirectory)) {
    files[file] = createHash('sha256').update(readFileSync(resolve(packageDirectory, file))).digest('hex');
  }
  return files;
}

/**
 * Record the sources a build was made from, next to the built output.
 *
 * The record is written after the compile succeeded, so a build that
 * failed leaves no record and the freshness check says the output was
 * never built rather than that it was built from something else.
 */
export function writeBuildStamp(packageDirectory) {
  const stamp = resolve(packageDirectory, 'dist', BUILD_STAMP_FILE);
  writeFileSync(stamp, `${JSON.stringify({ files: buildSources(packageDirectory) }, null, 2)}\n`);
}
