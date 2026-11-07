import { describe, expect, it } from "vitest";
import { selectLoopStatusCandidate, type LoopStatusCandidate } from "../../electron/services/loop-status-selection.js";

const alive = new Set([101, 202]);
const isAlive = (pid: number) => alive.has(pid);

const snapshot = (tag: string, pid: number | undefined, modifiedAt: number): LoopStatusCandidate => ({
  tag,
  modifiedAt,
  raw: JSON.stringify(pid === undefined ? { totals: { completed: 0 } } : { pid, totals: { completed: 0 } }),
});

describe("loop status snapshot selection", () => {
  it("prefers a live tagged run over a dead default one", () => {
    // The card used to pick `default` by file presence, so this case showed
    // "stopped" while a loop was working.
    const chosen = selectLoopStatusCandidate([
      snapshot("default", 999, 500),
      snapshot("k-base-3-ab12cd", 202, 100),
    ], isAlive);

    expect(chosen?.tag).toBe("k-base-3-ab12cd");
  });

  it("keeps the default run when it is the live one, even if another is newer", () => {
    const chosen = selectLoopStatusCandidate([
      snapshot("k-base-3-ab12cd", 202, 900),
      snapshot("default", 101, 100),
    ], isAlive);

    expect(chosen?.tag).toBe("default");
  });

  it("falls back to the newest run when nothing is alive and no default exists", () => {
    const chosen = selectLoopStatusCandidate([
      snapshot("api-42-0011aa", 998, 100),
      snapshot("k-base-3-ab12cd", 997, 700),
    ], isAlive);

    expect(chosen?.tag).toBe("k-base-3-ab12cd");
  });

  it("falls back to the default run when every run is dead and it exists", () => {
    const chosen = selectLoopStatusCandidate([
      snapshot("k-base-3-ab12cd", 998, 700),
      snapshot("default", 999, 100),
    ], isAlive);

    expect(chosen?.tag).toBe("default");
  });

  it("still reads the previous single-loop layout", () => {
    expect(selectLoopStatusCandidate([snapshot("legacy", 101, 10)], isAlive)?.tag).toBe("legacy");
    expect(selectLoopStatusCandidate([snapshot("legacy", 999, 10)], isAlive)?.tag).toBe("legacy");
  });

  it("treats a snapshot without a usable pid as not alive", () => {
    const chosen = selectLoopStatusCandidate([
      snapshot("default", undefined, 900),
      snapshot("k-base-3-ab12cd", 202, 100),
    ], isAlive);

    expect(chosen?.tag).toBe("k-base-3-ab12cd");
  });

  it("returns nothing when no run has ever written a snapshot", () => {
    expect(selectLoopStatusCandidate([], isAlive)).toBeUndefined();
  });
});
