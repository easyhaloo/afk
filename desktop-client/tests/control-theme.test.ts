import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const stylesheet = readFileSync(path.resolve(here, "../src/control.css"), "utf8");
const palette = readFileSync(path.resolve(here, "../src/palette.css"), "utf8");

describe("graphite theme selected controls", () => {
  it("uses theme-aware selected setting surfaces and text", () => {
    expect(stylesheet).toContain(':root[data-afk-theme="graphite"] .settings-section .setting-options button.selected { background: color-mix(in srgb, var(--afk-accent) 12%, var(--afk-panel)); }');
    expect(stylesheet).toContain(':root[data-afk-theme="graphite"] .settings-section .setting-options button.selected b { color: var(--afk-text); }');
    expect(stylesheet).toContain(':root[data-afk-theme="graphite"] .settings-section .setting-options button.selected span { color: var(--afk-muted); }');
  });

  it("uses appearance accent tokens for the selected run view", () => {
    expect(palette).toContain(".topbar .header-run-mode button.active { background: var(--afk-accent-soft); color: var(--afk-accent);");
    expect(palette).toContain("border-color: var(--afk-accent-border)");
  });
});
