import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(path.resolve(__dirname, "../src/control.css"), "utf8");

describe("graphite theme selected controls", () => {
  it("keeps selected setting titles readable on accent-soft backgrounds", () => {
    expect(stylesheet).toContain(':root[data-afk-theme="graphite"] .settings-section .setting-options button.selected');
    expect(stylesheet).toContain(':root[data-afk-theme="graphite"] .settings-section .setting-options button.selected b');
    expect(stylesheet).toContain(':root[data-afk-theme="graphite"] .settings-section .setting-options button.selected span');
    expect(stylesheet).toContain("color: #303136");
    expect(stylesheet).toContain("color: #5f6068");
  });
});
