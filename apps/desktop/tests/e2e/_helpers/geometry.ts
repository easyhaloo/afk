import { expect, type Page } from "@playwright/test";

/**
 * Layout assertions that `toBeVisible()` cannot make.
 *
 * Playwright's visibility check answers exactly one question — does this
 * element have a non-empty box — and stops there. It cannot see an ancestor
 * clipping the element away, and it holds no opinion on whether a header lines
 * up with the cells beneath it. Both defects shipped green through this suite:
 * a workflow stage at 0px behind eleven passing tests, and a four-track column
 * header sitting over five-track rows. Measuring is the only way to see them.
 */

/** Each child's left edge in viewport coordinates. */
async function columnOffsets(page: Page, selector: string) {
  return page.evaluate(sel => {
    const parent = document.querySelector(sel);
    if (!parent) return null;
    return [...parent.children].map(child => {
      const box = child.getBoundingClientRect();
      return { label: (child.textContent ?? "").trim().slice(0, 12), left: Math.round(box.left) };
    });
  }, selector);
}

/**
 * Asserts every column of `head` starts where the matching cell of `row`
 * starts, and that the two carry the same number of columns.
 *
 * Columns are compared in viewport coordinates, so a header whose whole grid
 * is nudged sideways fails just as loudly as one whose cells are misaligned
 * within it — both mean each label points at the wrong data. The sub-pixel
 * tolerance absorbs fractional device-pixel rounding, nothing more.
 */
export async function expectColumnsAligned(page: Page, head: string, row: string, tolerance = 3) {
  const headColumns = await columnOffsets(page, head);
  const rowColumns = await columnOffsets(page, row);
  expect(headColumns, `${head} is not in the DOM`).not.toBeNull();
  expect(rowColumns, `${row} is not in the DOM — nothing to align against`).not.toBeNull();
  expect(
    headColumns!.length,
    `${head} has ${headColumns!.length} columns but ${row} has ${rowColumns!.length} cells`,
  ).toBe(rowColumns!.length);

  const drift = headColumns!
    .map((column, index) => ({ label: column.label || `column ${index + 1}`, by: column.left - rowColumns![index]!.left }))
    .filter(column => Math.abs(column.by) > tolerance);
  expect(
    drift,
    `${head} columns sit off their ${row} cells: ${drift.map(c => `${c.label} by ${c.by}px`).join(", ")}`,
  ).toEqual([]);
}

/**
 * Asserts `selector` actually occupies vertical space.
 *
 * Guards the collapse that `toBeVisible()` waves through: an element with a
 * height but no room in a clipped ancestor still reports visible.
 */
export async function expectOccupiesSpace(page: Page, selector: string, minHeight = 8) {
  const box = await page.locator(selector).first().boundingBox();
  expect(box, `${selector} has no box at all`).not.toBeNull();
  expect(box!.height, `${selector} collapsed to ${box!.height}px`).toBeGreaterThan(minHeight);
}
