import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Point the runtime registry somewhere disposable for the whole test run.
 *
 * The registry is a file under the user's home directory. A test that
 * registers a resource writes into the developer's own machine unless it
 * says where the registry lives, and the rows accumulate there until
 * somebody clears them by hand - which is how a developer's registry ends
 * up holding thousands of rows for worktrees that no longer exist.
 *
 * One file per test, all in one disposable directory: the files do not
 * share state, and the directory does not fill up with one folder per
 * test.
 */
const root = join(tmpdir(), 'afk-runtime-registry-tests');
mkdirSync(root, { recursive: true });
process.env.AFK_RUNTIME_REGISTRY_PATH = join(root, `resources-${process.pid}-${randomUUID()}.sqlite`);
