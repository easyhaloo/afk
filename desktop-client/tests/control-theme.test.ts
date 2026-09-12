import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(path.resolve(__dirname, "../src/control.css"), "utf8");
const palette = readFileSync(path.resolve(__dirname, "../src/palette.css"), "utf8");

describe("graphite theme selected controls", () => {
  it("keeps selected setting titles readable on accent-soft backgrounds", () => {
    expect(stylesheet).toContain(':root[data-afk-theme="graphite"] .settings-section .setting-options button.selected');
    expect(stylesheet).toContain(':root[data-afk-theme="graphite"] .settings-section .setting-options button.selected b');
    expect(stylesheet).toContain(':root[data-afk-theme="graphite"] .settings-section .setting-options button.selected span');
    expect(stylesheet).toContain("color: #303136");
    expect(stylesheet).toContain("color: #5f6068");
  });

  it("uses appearance accent tokens for the selected run view", () => {
    expect(palette).toContain(".topbar .header-run-mode button.active { background: var(--afk-accent-soft); color: var(--afk-accent);");
    expect(palette).toContain("border-color: var(--afk-accent-border)");
  });
});
