import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const FORBIDDEN_AGENT_EXECUTABLE = /^(?:claude(?:-code)?|codex)(?:[-.]|$)/i;
const MAX_SINGLE_FILE_BYTES = 50 * 1024 * 1024;

async function walk(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries.map(entry => ({
    entry,
    path: join(entry.parentPath ?? entry.path, entry.name),
  }));
}

/**
 * Reject actual Agent CLI executables in a release tree.
 *
 * Runtime source directories such as "codex-app-server" are expected parts of
 * @afk/runtime and must not be confused with bundled external executables.
 * Executables are identified by their command basename and executable mode.
 * The per-file size guard remains independent of the name check.
 */
export async function assertNoBundledAgent(directory) {
  const executables = [];
  const oversized = [];

  for (const { entry, path } of await walk(directory)) {
    if (!entry.isFile()) continue;

    const { size, mode } = await stat(path);
    if (size > MAX_SINGLE_FILE_BYTES) {
      oversized.push(`${(size / 1024 / 1024).toFixed(0)}MB ${path}`);
    }
    if ((mode & 0o111) !== 0 && FORBIDDEN_AGENT_EXECUTABLE.test(entry.name)) {
      executables.push(path);
    }
  }

  const offenders = [...executables, ...oversized];
  if (offenders.length) {
    throw new Error(
      `refusing to package agent executables or oversized files:\n  ${offenders.join('\n  ')}`,
    );
  }
}
