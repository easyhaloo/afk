import { describe, expect, it } from "vitest";
import { IPC_CHANNELS as SHARED } from "../../shared/ipc-contract";
import { IPC_CHANNELS as PRELOAD } from "../../electron/preload-channels.cjs";

/**
 * The preload cannot import the shared contract's table at runtime: a
 * sandboxed preload is CommonJS and the shared module is ESM. So the wire
 * names live in two places, and this test is what keeps them from drifting
 * apart silently.
 */
describe("preload channel table", () => {
  it("matches the shared contract's table", () => {
    expect(PRELOAD).toEqual(SHARED);
  });

  it("names every channel in the afk: namespace", () => {
    for (const [key, channel] of Object.entries(PRELOAD)) {
      expect(channel, key).toMatch(/^afk:[a-z0-9-]+$/);
    }
  });
});
