import { test, expect } from "./_helpers/launch";
import { expectColumnsAligned } from "./_helpers/geometry";

/**
 * Proves the geometry assertions can go red. A guard that only ever passes is
 * decoration — and the first version of `expectColumnsAligned` measured columns
 * relative to each element's own parent, so it caught a misaligned cell but
 * sailed past a whole row nudged sideways. Only this test noticed.
 */
test("geometry assertions catch real drift", async ({ page }) => {
  await page.locator(".primary-nav button", { hasText: "代码仓库" }).click();
  await page.waitForTimeout(500);

  const first = ".repository-list .row-item:nth-of-type(1)";
  const second = ".repository-list .row-item:nth-of-type(2)";
  expect(await page.locator(first).count(), "fixture served no repository rows").toBe(1);
  expect(await page.locator(second).count()).toBe(1);

  // Baseline: two rows of the same list must share their column positions.
  await expectColumnsAligned(page, first, second);

  // Nudge one whole row sideways — the header-equivalent of a misaligned grid.
  await page.addStyleTag({ content: `.repository-list .row-item:nth-of-type(2) { margin-left: 40px; }` });
  let shifted = false;
  try {
    await expectColumnsAligned(page, first, second);
  } catch {
    shifted = true;
  }
  expect(shifted, "a 40px shift went undetected").toBe(true);

  // Drop a cell — the column count must stop matching.
  await page.reload();
  await page.locator(".primary-nav button", { hasText: "代码仓库" }).click();
  await page.waitForTimeout(500);
  await page.addStyleTag({ content: `.repository-list .row-item:nth-of-type(2) .end { display: none; }` });
  let shortRow = false;
  try {
    await expectColumnsAligned(page, first, second);
  } catch {
    shortRow = true;
  }
  expect(shortRow, "a missing cell went undetected").toBe(true);
});
