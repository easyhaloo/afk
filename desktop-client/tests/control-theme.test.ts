import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../src");
const tokens = readFileSync(path.join(src, "tokens.css"), "utf8");

// 293 as of the reskin: control.css 167, replay.css 80, ssh.css 35,

// Hardcoded colours outside tokens.css: 293 as of the reskin — control.css 167,
// replay.css 80, ssh.css 35, ssh-terminal.css 8, layout.css 3. None of them
// fail contrast today; this only stops the number growing.
const MAX_CSS_HEXES = 293;

const stylesheets = readdirSync(src, { recursive: true, encoding: "utf8" })
  .filter(name => name.endsWith(".css"))
  .map(name => readFileSync(path.join(src, name), "utf8"))
  .join("\n");

/** Token names declared by a chunk of CSS. */
function declared(chunk: string): Set<string> {
  return new Set(Array.from(chunk.matchAll(/(--[\w-]+)\s*:/g), match => match[1]));
}

/**
 * Palette tokens a theme must restate. Structural tokens (fonts, motion,
 * density) are theme-agnostic and live only in the dark block. The --shadow-*
 * trio is deliberately excluded: each is a literal offset over
 * var(--ink-shadow), so restating --ink-shadow is enough to retheme them.
 */
const isPaletteToken = (name: string) =>
  /^--(paper|ink|accent|warn|fail)(-|$)/.test(name);

describe("design tokens", () => {
  it("declares the same palette in both themes", () => {
    // A token added to one theme and forgotten in the other is invisible in
    // whichever theme you happened to be looking at.
    const darkPalette = tokens.slice(
      tokens.indexOf("2. palette: dark"),
      tokens.indexOf("2b. palette: light"),
    );
    const light = declared(tokens.slice(tokens.indexOf(':root[data-afk-theme="light"]')));

    const expected = Array.from(declared(darkPalette)).filter(isPaletteToken);
    expect(expected.length).toBeGreaterThan(20);
    for (const name of expected) {
      expect(light.has(name), `${name} is missing from the light theme`).toBe(true);
    }
  });

  it("keeps one accent that doubles as the running state", () => {
    // The five run states are told apart by their glyph, not by five hues.
    expect(tokens).toContain("--run: var(--accent);");
    expect(tokens).toContain("--verify: var(--accent);");
    expect(tokens).toContain("--afk-accent: var(--accent);");
  });

  it("aliases with plain var() so color-mix() can still resolve", () => {
    // selection.css wraps these in color-mix(), which substitutes variables
    // before mixing. An alias that mixes itself would fail at computed time.
    const aliasBlock = tokens.slice(tokens.indexOf("3b. alias layer"));
    const mixedAliases = Array.from(
      aliasBlock.matchAll(/^\s*(--[\w-]+):\s*(color-mix[^;]+);/gm),
      match => match[1],
    );
    expect(mixedAliases).toEqual([]);
  });

  it("defines the four tokens that were consumed but never declared", () => {
    // These rules were silently invalid: an undefined var() with no fallback
    // drops the whole declaration.
    expect(tokens).toContain("--afk-danger: var(--fail);");
    expect(tokens).toContain("--afk-subtle: var(--paper-3);");
    expect(tokens).toContain("--afk-mono: var(--font-mono);");
    expect(tokens).toContain("--font-mono:");
  });

  it("keeps hardcoded colours ratcheted down", () => {
    // The contrast spec only measures rendered text, so a hardcoded background
    // or border that no text sits on is invisible to it — a view added later,
    // or one cascade change away, can expose it. This bounds the total so the
    // number can only fall.
    //
    // tokens.css is excluded: its hexes ARE the palette definitions.
    const residue = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".css") && name !== "tokens.css")
      .map((name) => {
        const body = readFileSync(path.join(src, name), "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          // var(--x, #abc) fallbacks are inert; --x is always defined.
          .replace(/var\([^)]*,[^)]*#[0-9a-fA-F]{3,8}[^)]*\)/g, "");
        return Array.from(body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)).length;
      })
      .reduce((a, b) => a + b, 0);

    expect(
      residue,
      `${residue} hardcoded colours outside tokens.css (limit ${MAX_CSS_HEXES})`,
    ).toBeLessThanOrEqual(MAX_CSS_HEXES);
  });

  it("has no leftover graphite or per-accent theming", () => {
    // Both were override systems. A theme is now a token swap; if these come
    // back, something is recolouring components instead of tokens.
    expect(stylesheets).not.toContain("graphite");
    expect(stylesheets).not.toContain("data-afk-accent");
  });
});