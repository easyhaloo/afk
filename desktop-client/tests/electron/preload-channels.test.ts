import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc-contract";

/**
 * One channel table, one validated snapshot — the wire names live in the
 * shared contract only. The preload reaches for them through that table
 * instead of keeping a copy, so the two cannot drift apart silently; these
 * assertions guard the remaining risk, which is somebody re-introducing a
 * literal channel name next to the preload.
 */
const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const preloadSource = readFileSync(path.join(desktopRoot, "electron", "preload.ts"), "utf8");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.tsx?$/.test(entry.name) ? [target] : [];
  });
}

describe("preload channel table", () => {
  it("reads its channel names from the shared contract", () => {
    expect(preloadSource).toMatch(/import\s*\{[^}]*\bIPC_CHANNELS\b[^}]*\}\s*from\s*"\.\.\/shared\/ipc-contract\.js"/);
  });

  it("keeps no channel literal of its own", () => {
    expect(preloadSource).not.toMatch(/["']afk:[a-z0-9-]+["']/);
    expect(preloadSource).not.toContain("preload-channels");
  });

  it("reaches only for channels the shared table declares", () => {
    const referenced = [...preloadSource.matchAll(/IPC_CHANNELS\.([A-Za-z0-9_]+)/g)].map(match => match[1]);
    expect(referenced.length).toBeGreaterThan(0);
    for (const key of referenced) {
      expect(Object.prototype.hasOwnProperty.call(IPC_CHANNELS, key), key).toBe(true);
    }
  });

  it("declares every channel exactly once in the shared table", () => {
    const values = Object.values(IPC_CHANNELS);
    expect(new Set(values).size).toBe(values.length);
  });

  it("names every channel in the afk: namespace", () => {
    for (const [key, channel] of Object.entries(IPC_CHANNELS)) {
      expect(channel, key).toMatch(/^afk:[a-z0-9-]+$/);
    }
  });

  it("leaves the shared contract the only module that spells a channel name", () => {
    const owners = [...sourceFiles(path.join(desktopRoot, "electron")), ...sourceFiles(path.join(desktopRoot, "shared"))]
      .filter(file => /["']afk:[a-z0-9-]+["']/.test(readFileSync(file, "utf8")))
      .map(file => path.relative(desktopRoot, file));
    expect(owners).toEqual([path.join("shared", "ipc-contract.ts")]);
  });
});
