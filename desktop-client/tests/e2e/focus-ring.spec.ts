import { expect, test } from "./_helpers/launch";

/**
 * Focus rings are invisible to everything else here: the contrast spec reads
 * computed colour, unit tests assert class names, and screenshots never hold
 * a focus state. This is the only check that a keyboard user can still see
 * where they are — every rule it guards used to kill the global outline with
 * `outline: none` and hand-roll a box-shadow ring instead.
 */

/**
 * `:focus-visible` does NOT match a programmatic .focus(). Chromium only
 * treats programmatic focus as focus-visible if the last input was a key, so
 * press a key first or this reads back `outline-style: none` and every
 * assertion below passes for the wrong reason.
 */
async function ringOf(page: import("@playwright/test").Page, selector: string) {
  await page.keyboard.press("Tab");
  return page.locator(selector).first().evaluate(el => {
    el.focus();
    const s = getComputedStyle(el);
    return { width: s.outlineWidth, style: s.outlineStyle, colour: s.outlineColor };
  });
}

function expectVisibleRing(ring: { width: string; style: string; colour: string }) {
  const shown = `${ring.width} ${ring.style} ${ring.colour}`;
  expect(ring.style, shown).not.toBe("none");
  expect(parseFloat(ring.width), shown).toBeGreaterThanOrEqual(2);
}

async function openView(page: import("@playwright/test").Page, label: string) {
  await page.locator(".primary-nav button", { hasText: label }).click();
  await page.waitForTimeout(300);
}

test.describe("focus ring", () => {
  test("SSH action buttons fall through to the global outline", async ({ page }) => {
    await openView(page, "SSH 主机");
    const button = page.locator(".ssh-action-button");
    test.skip(await button.count() === 0, "no SSH fixture");
    expectVisibleRing(await ringOf(page, ".ssh-action-button"));
  });

  test("the host row draws its ring inside, because the list clips", async ({ page }) => {
    await openView(page, "SSH 主机");
    const row = page.locator(".ssh-host-select");
    test.skip(await row.count() === 0, "no SSH hosts in the fixture");
    expectVisibleRing(await ringOf(page, ".ssh-host-select"));
  });

  test("the load-more button on the work items page", async ({ page }) => {
    await openView(page, "工作项");
    const more = page.locator(".work-items-load-more button");
    test.skip(await more.count() === 0, "no work items to page through");
    expectVisibleRing(await ringOf(page, ".work-items-load-more button"));
  });

  test("the select-menu trigger, which used to hand-roll its own ring", async ({ page }) => {
    await openView(page, "工作项");
    const trigger = page.locator(".select-menu-trigger");
    test.skip(await trigger.count() === 0, "no select-menu on this view");
    expectVisibleRing(await ringOf(page, ".select-menu-trigger"));
  });
});