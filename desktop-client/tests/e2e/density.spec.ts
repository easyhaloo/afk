import { expect, test } from "./_helpers/launch";

/**
 * The ratchet in control-theme.test.ts proves every font size *reads*
 * --afk-scale. This proves the scale reaches the DOM at all: main.tsx writes
 * it onto <html> through `dataset`, so deleting that one line leaves the
 * ratchet green and 字号密度 silently dead again.
 *
 * It failed for real once — 287 of 396 sizes were bare px literals, so the
 * setting moved the nav and nothing else.
 */
const SAMPLED = [".nav-item", ".backlog-page"] as const;

async function setDensity(page: import("playwright").Page, label: string) {
  await page.locator(".primary-nav button", { hasText: "设置" }).click();
  await page.getByRole("radiogroup", { name: "字号密度" }).getByText(label).click();
  await page.waitForTimeout(250);
  await page.locator(".primary-nav button", { hasText: "本地 Backlog" }).click();
  await page.waitForTimeout(400);
}

function sample(page: import("playwright").Page) {
  return page.evaluate(sels => {
    const out: Record<string, string> = {};
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el) out[sel] = getComputedStyle(el).fontSize;
    }
    return out;
  }, SAMPLED);
}

test("字号密度 scales text that a bare px size would have frozen", async ({ page }) => {
  await setDensity(page, "标准");
  const medium = await sample(page);
  await setDensity(page, "舒展");
  const large = await sample(page);
  await setDensity(page, "紧凑");
  const small = await sample(page);

  for (const sel of SAMPLED) {
    const seen = `标准 ${medium[sel]} / 舒展 ${large[sel]} / 紧凑 ${small[sel]}`;
    expect(medium[sel], `${sel} did not render: ${seen}`).toBeDefined();
    expect(large[sel], `${sel} did not render: ${seen}`).toBeDefined();
    expect(small[sel], `${sel} did not render: ${seen}`).toBeDefined();
    const shown = `${sel} stayed at ${medium[sel]} → ${seen}`;
    expect(parseFloat(large[sel]) / parseFloat(medium[sel]), shown).toBeGreaterThan(1.05);
    expect(parseFloat(small[sel]) / parseFloat(medium[sel]), shown).toBeLessThan(0.98);
  }
});
