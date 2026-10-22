import { expect, test } from "./_helpers/launch.js";
import { seedSelectionInventory } from "./_helpers/inventory.js";

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
async function ringOf(page: import("playwright").Page, selector: string) {
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

async function openView(page: import("playwright").Page, label: string) {
  await page.locator(".primary-nav button", { hasText: label }).click();
  await page.waitForTimeout(300);
}

test.describe("focus ring", () => {
  test("SSH action buttons fall through to the global outline", async ({ page }) => {
    await openView(page, "SSH 主机");
    const button = page.locator(".ssh-action-button");
    await expect(button.first()).toBeVisible();
    expectVisibleRing(await ringOf(page, ".ssh-action-button"));
  });

  test("the host row draws its ring inside, because the list clips", async ({ page }) => {
    await page.evaluate(() => window.afkDesktop.ssh.add({ alias: "focus-host", hostname: "127.0.0.1", port: 1 }));
    await openView(page, "SSH 主机");
    const row = page.locator(".ssh-host-select");
    await expect(row.first()).toBeVisible();
    expectVisibleRing(await ringOf(page, ".ssh-host-select"));
  });

  test("the load-more button on the work items page", async ({ electronApp, page }) => {
    await seedSelectionInventory(electronApp, page, 51);
    await openView(page, "工作项");
    const more = page.locator(".work-items-load-more button");
    await expect(more).toBeVisible();
    expectVisibleRing(await ringOf(page, ".work-items-load-more button"));
    await more.click();
    await expect(page.locator(".backlog-row.work-item-row")).toHaveCount(51);
    await expect(more).toBeHidden();
  });

  test("the select-menu trigger, which used to hand-roll its own ring", async ({ page }) => {
    await openView(page, "工作项");
    await page.getByRole("button", { name: "筛选工作项" }).click();
    const trigger = page.locator(".select-menu-trigger");
    await expect(trigger.first()).toBeVisible();
    expectVisibleRing(await ringOf(page, ".select-menu-trigger"));
  });
});
