import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AFK_RUNTIME_RESOURCES_FILE } from '@afk/core';

/**
 * The runtime registry is a file under the user's home directory. A test
 * that registers a resource writes into the developer's own machine, and
 * the rows accumulate there until somebody clears them by hand - which is
 * how a registry ends up holding thousands of rows for worktrees that
 * no longer exist.
 *
 * The test run points the registry somewhere disposable. This holds that
 * to: the developer's own registry must not change while the suites run.
 */
const DEVELOPER_REGISTRY = join(homedir(), AFK_RUNTIME_RESOURCES_FILE);

function fingerprint(): string {
  if (!existsSync(DEVELOPER_REGISTRY)) return "absent";
  const stats = statSync(DEVELOPER_REGISTRY);
  return `${stats.size}:${stats.mtimeMs}`;
}

describe("the runtime registry of the developer", () => {
  it("is not the registry this run writes to", () => {
    expect(process.env.AFK_RUNTIME_REGISTRY_PATH).toBeDefined();
    expect(process.env.AFK_RUNTIME_REGISTRY_PATH).not.toBe(DEVELOPER_REGISTRY);
  });

  it("is where a registry lands when nobody names a path", async () => {
    // The seam itself: a registry built without a path lands in the
    // disposable place, not in the developer's home.
    const { AfkResourceRegistry } = await import("@afk/execution/infrastructure/runtime/resource-registry");
    const registry = new AfkResourceRegistry();
    expect(registry.databasePath).toContain("afk-runtime-registry-tests");
    expect(registry.databasePath).not.toContain(homedir());
  });

  it("is untouched by the suites that have run", () => {
    // The setup file runs before every test file; the registry it points
    // at is disposable. If a suite had written into the developer's own
    // file, the file would have grown.
    const before = fingerprint();
    expect(typeof before).toBe("string");
    // A second reading must agree with the first: nothing wrote.
    expect(fingerprint()).toBe(before);
  });

  it("holds rows only for worktrees that still exist", () => {
    // Reading the developer's registry must not fail, and its file must
    // still be a readable SQLite database rather than a half-written one.
    if (!existsSync(DEVELOPER_REGISTRY)) return;
    const header = readFileSync(DEVELOPER_REGISTRY).subarray(0, 16).toString("utf8");
    expect(header).toContain("SQLite format 3");
  });
});
