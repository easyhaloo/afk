import { describe, expect, it } from "vitest";
import { cleanAppearance, DEFAULT_APPEARANCE } from "../electron/services/appearance-service";

describe("appearance preferences", () => {
  it("migrates preferences without a locale to system", () => {
    expect(cleanAppearance({ theme: "graphite" })).toEqual({ ...DEFAULT_APPEARANCE, theme: "graphite" });
    expect(cleanAppearance({ locale: "en-US" }).locale).toBe("en-US");
    expect(cleanAppearance({ locale: "unsupported" }).locale).toBe("system");
  });
});
