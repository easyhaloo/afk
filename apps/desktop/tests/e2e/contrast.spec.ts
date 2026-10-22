import { test, expect } from "./_helpers/launch.js";
import { navButton } from "./_helpers/nav.js";

/**
 * WCAG AA contrast ratchet.
 *
 * A ratchet, not a gate: the count may only fall. Decrement MAX_FAILURES as
 * pages are fixed. It prints the offending elements so the number is
 * actionable rather than an opaque red build.
 *
 * Three measurement rules that earlier versions of this check got wrong, all
 * of which produced confident nonsense:
 *
 *  1. Background must be resolved by walking ancestors, because the app paints
 *     a texture on html::before and most surfaces are translucent tints.
 *  2. Translucent backgrounds must be composited over what is behind them.
 *     --accent-bg is rgba(accent, .10); reading its RGB and calling it opaque
 *     scores accent-on-accent at 1:1, which is not what the eye sees.
 *  3. A colour that cannot be parsed must be reported as unmeasurable, never
 *     defaulted to black — a guess becomes a confident wrong number.
 *
 * This lives as a spec rather than a standalone script because the app only
 * boots under the Playwright runner.
 */

// 0. The reskin took this from 24 real failures to zero: most were light-theme
// hexes stranded on dark paper at 1.6:1, the rest were the accent used as text
// on its own tint. Keep it at 0 — raising it needs a reason in the diff.
// A handful of elements stay "unmeasurable" (colours the parser cannot read);
// they are counted and printed separately, never scored as passes.
const MAX_FAILURES = 0;

const VIEWS = [
  "工作项", "运行中心", "工作流", "Agents",
  "代码仓库", "执行环境", "SSH 主机", "活动记录", "设置",
] as const;

type Failure = { selector: string; text: string; fg: string; bg: string; ratio: number; threshold: number };

test.describe("WCAG AA contrast", () => {
  test("does not regress past the ratchet", async ({ page }) => {
    const failures: Failure[] = [];
    let unmeasurable = 0;

    for (const theme of ["light", "dark"] as const) {
      await page.locator("html").evaluate((el, t) => { el.dataset.afkTheme = t; }, theme);

      for (const label of VIEWS) {
        await navButton(page, label).first().click();
        await page.waitForTimeout(350);

        const result = await page.evaluate(() => {
          type RGB = [number, number, number];
          type Layer = { rgb: RGB; a: number };

          function parseColor(css: string | null): Layer | null {
            if (!css) return null;
            const s = css.trim();
            if (s === "transparent") return null;

            const fn = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
            if (fn) {
              const a = fn[4] === undefined ? 1
                : (fn[4].endsWith("%") ? parseFloat(fn[4]) / 100 : parseFloat(fn[4]));
              if (a === 0) return null;
              return { rgb: [Number(fn[1]), Number(fn[2]), Number(fn[3])], a };
            }
            const hex = s.match(/^#([0-9a-f]{3,8})$/i);
            if (hex) {
              let x = hex[1];
              if (x.length === 3 || x.length === 4) x = x.split("").map((c) => c + c).join("");
              if (x.length === 6) {
                return { rgb: [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)], a: 1 };
              }
              if (x.length === 8) {
                const a = parseInt(x.slice(6, 8), 16) / 255;
                if (a === 0) return null;
                return { rgb: [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)], a };
              }
            }
            return null;
          }

          function luminance([r, g, b]: RGB): number {
            const c = [r, g, b].map((v) => {
              const x = v / 255;
              return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
          }

          /** Composite translucent layers from the element upward. */
          function effectiveBg(el: Element): RGB | null {
            const layers: Layer[] = [];
            let node: Element | null = el;
            for (let i = 0; i < 20 && node; i++) {
              const parsed = parseColor(getComputedStyle(node).backgroundColor);
              if (parsed) {
                layers.push(parsed);
                if (parsed.a >= 1) break;
              }
              node = node.parentElement;
            }
            if (layers.length) {
              let base: RGB = [255, 255, 255];
              for (let i = layers.length - 1; i >= 0; i--) {
                const { rgb, a } = layers[i];
                base = [0, 1, 2].map((k) => rgb[k] * a + base[k] * (1 - a)) as RGB;
              }
              return base.map(Math.round) as RGB;
            }
            // Probe --paper* rather than reading raw token text, which is hex.
            const probe = document.createElement("span");
            probe.style.cssText = "position:absolute;width:0;height:0;visibility:hidden";
            document.body.appendChild(probe);
            for (const name of ["--paper", "--paper-2", "--paper-3", "--paper-in"]) {
              probe.style.backgroundColor = "";
              probe.style.backgroundColor = `var(${name})`;
              const c = parseColor(getComputedStyle(probe).backgroundColor);
              if (c && c.a >= 1) { probe.remove(); return c.rgb; }
            }
            probe.remove();
            return null;
          }

          const out: Array<{ selector: string; text: string; fg: string; bg: string; ratio: number; threshold: number }> = [];
          let skipped = 0;
          const seen = new Set<Element>();
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode: (n) => (n.textContent && n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
          });

          let node: Node | null;
          while ((node = walker.nextNode())) {
            const el = node.parentElement;
            if (!el || seen.has(el)) continue;
            seen.add(el);
            const cs = getComputedStyle(el);
            if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;

            const fgLayer = parseColor(cs.color);
            const bg = effectiveBg(el);
            if (!fgLayer || fgLayer.a === 0 || !bg) { skipped++; continue; }

            const l1 = luminance(fgLayer.rgb);
            const l2 = luminance(bg);
            const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
            const fontSize = parseFloat(cs.fontSize);
            const fontWeight = parseInt(cs.fontWeight, 10) || 400;
            const threshold = (fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700)) ? 3 : 4.5;

            if (ratio < threshold) {
              const cls = (el.className || "").toString().replace(/\s+/g, ".").slice(0, 80);
              out.push({
                selector: el.tagName + (cls ? "." + cls : ""),
                text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 50),
                fg: `rgb(${fgLayer.rgb.join(",")})`,
                bg: `rgb(${bg.join(",")})`,
                ratio: Math.round(ratio * 100) / 100,
                threshold,
              });
            }
          }
          return { failures: out, skipped };
        });

        failures.push(...result.failures.map((f) => ({ ...f })));
        unmeasurable += result.skipped;
      }
    }

    failures.sort((a, b) => a.ratio - b.ratio);
    console.log(`\ncontrast: ${failures.length} AA failures, ${unmeasurable} unmeasurable (limit ${MAX_FAILURES})`);
    for (const f of failures.slice(0, 20)) {
      console.log(`  ${f.ratio}:1 (need ${f.threshold})  ${f.fg} on ${f.bg}  ${f.selector}  "${f.text}"`);
    }
    if (failures.length > 20) console.log(`  ... and ${failures.length - 20} more`);

    expect(failures.length, `${failures.length} AA contrast failures (limit ${MAX_FAILURES})`).toBeLessThanOrEqual(MAX_FAILURES);
  });
});