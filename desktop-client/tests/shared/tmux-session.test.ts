import { describe, expect, it } from "vitest";
import { normalizeTmuxSessionName } from "../../shared/tmux-session";

describe("normalizeTmuxSessionName", () => {
  it("rewrites colons the same way tmux stores session names", () => {
    expect(normalizeTmuxSessionName("github:easyhaloo/afk#144")).toBe("github_easyhaloo/afk#144");
    expect(normalizeTmuxSessionName("afk-144-implement")).toBe("afk-144-implement");
  });
});
