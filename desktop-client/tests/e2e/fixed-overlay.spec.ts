import { expect, test } from "./_helpers/launch";

/**
 * A non-`none` transform on an ancestor makes it the containing block for
 * `position: fixed` descendants — even a pure identity matrix counts, and
 * dropping the transform from a keyframe's `to` does not help, because
 * Chromium still computes `matrix(1, 0, 0, 1, 0, 0)`.
 *
 * Every overlay here renders inline inside a view component rather than in
 * the prototype's separate #overlay container, so animating a view's root
 * silently shrinks its modals and drawers to the view's content box. It
 * does not throw and it does not log: a drawer that was full-window comes
 * back 396px wide. Nothing else in this suite would notice — the unit
 * tests assert class names, the contrast spec reads computed colour, and
 * the screenshots never open a drawer.
 */
test("a fixed overlay inside a view fills the window, not the view box", async ({ page }) => {
  await page.locator(".primary-nav button", { hasText: "工作项" }).click();
  await page.waitForTimeout(400);
  const row = page.locator(".work-item-row").first();
  test.skip(await row.count() === 0, "no work item rows in the fixture");
  await row.click();
  await page.waitForTimeout(400);

  const measured = await page.evaluate(() => {
    const el = document.querySelector(".work-item-detail-layer");
    if (!el) return null;
    const blockers: string[] = [];
    for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.transform !== "none") blockers.push(`${n.tagName}.${n.className}: ${s.transform}`);
    }
    return { width: el.getBoundingClientRect().width, window: innerWidth, blockers };
  });

  test.skip(measured === null, "the click did not open the drawer");
  const shown = `${measured!.width}px of ${measured!.window}px; blockers: ${measured!.blockers.join(", ") || "none"}`;
  expect(measured!.blockers, shown).toEqual([]);
  expect(measured!.width, shown).toBeGreaterThan(measured!.window * 0.9);
});