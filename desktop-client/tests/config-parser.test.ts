import { describe, expect, it } from "vitest";
import { configNumber, configString, parseConfig } from "../electron/workflow/config-parser";

describe("workflow config parser", () => {
  it("uses YAML semantics for nested values and quoted comments", () => {
    const document = parseConfig(`agents:\n  codex:\n    provider: "open#ai"\nmaxRetries: 3\n`);

    expect(configString(document, "agents.codex.provider", "fallback")).toBe("open#ai");
    expect(configNumber(document, "maxRetries", 0)).toBe(3);
  });

  it("returns defaults for malformed or incompatible values", () => {
    const document = parseConfig("- not-an-object");

    expect(configString(document, "missing", "fallback")).toBe("fallback");
    expect(configNumber(document, "missing", 7)).toBe(7);
  });
});
