import { describe, expect, it } from "vitest";
import { normalizeCliInvocation } from "../../electron/lib/cli-invocation";

describe("CLI invocation", () => {
  it("accepts standalone binaries without a prefix", () => {
    expect(normalizeCliInvocation("/bin/afk")).toEqual({ command: "/bin/afk", args: [] });
  });

  it("retains a runtime and its script entry point", () => {
    const invocation = { command: "/bin/node", args: ["/repo/dist/index.js"] };
    expect(normalizeCliInvocation(invocation)).toBe(invocation);
  });
});
