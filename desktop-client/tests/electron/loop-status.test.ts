import { describe, expect, it } from "vitest";
import { parseLoopLastError } from "../../electron/services/desktop-service";

describe("loop status errors", () => {
  it("retains per-item errors without interpreting the former message field", () => {
    expect(parseLoopLastError({ "42": "execution-blocked", "43": "provider unavailable", bad: 1 })).toEqual({
      "42": "execution-blocked",
      "43": "provider unavailable",
    });
    expect(parseLoopLastError(null)).toEqual({});
  });
});
