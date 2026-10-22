import { test, expect } from "./_helpers/launch.js";
import { navButton } from "./_helpers/nav.js";

/**
 * Per-page smoke sweep: visit every renderer view and assert the page loads
 * without console errors, uncaught exceptions, or failed page loads.
 *
 * This complements the feature specs (which assert behaviour) by asserting
 * absence of errors on the pages they do not happen to touch.
 */

// Nav label -> view key, in navigation order.
const NAV_PAGES = [
  ["工作项", "backlog"],
  ["运行中心", "queue"],
  ["工作流", "workflows"],
  ["Agents", "agents"],
  ["代码仓库", "repositories"],
  ["执行环境", "containers"],
  ["SSH 主机", "ssh"],
  ["活动记录", "events"],
  ["设置", "settings"],
] as const;

test.describe("every page loads cleanly", () => {
  test("no console errors, uncaught exceptions or failed loads on any view", async ({ page }) => {
    const problems: string[] = [];

    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`[console] ${message.text()}`);
    });
    page.on("pageerror", (error) => {
      problems.push(`[pageerror] ${error.message}`);
    });
    page.on("requestfailed", (request) => {
      const failure = request.failure();
      // Vite HMR websockets and aborted navigations are noise, not page errors.
      if (request.url().startsWith("ws")) return;
      if (failure && !/ERR_ABORTED/.test(failure.errorText)) {
        problems.push(`[requestfailed] ${request.url()} — ${failure.errorText}`);
      }
    });

    // Settle the initial page before attributing errors to a view.
    await expect(page.locator(".primary-nav")).toBeVisible();
    await page.waitForTimeout(1500);
    const bootProblems = problems.splice(0, problems.length);
    expect(bootProblems, "boot").toEqual([]);

    for (const [label, key] of NAV_PAGES) {
      problems.length = 0;

      const button = navButton(page, label);
      await expect(button, `nav item ${label}`).toBeVisible();
      await button.click();

      // Give the view time to mount and issue its data calls.
      await page.waitForTimeout(1200);

      // The active nav item is the signal the view actually rendered.
      await expect(
        page.locator(".nav-item.active").filter({ hasText: label }),
        `${key} became active`,
      ).toBeVisible();

      expect(problems, `page ${key} (${label})`).toEqual([]);
    }

    // The board view is reached through the run-view switcher, not the nav.
    problems.length = 0;
    await page.locator(".primary-nav button", { hasText: "运行中心" }).click();
    await page.locator(".header-run-mode button", { hasText: "看板" }).click();
    await page.waitForTimeout(1200);
    await expect(
      page.locator(".header-run-mode button.active", { hasText: "看板" }),
      "board became active",
    ).toBeVisible();
    expect(problems, "page board (看板)").toEqual([]);
  });

  test("renderer root stays mounted with no error banner after the sweep", async ({ page }) => {
    await expect(page.locator("#root")).toBeVisible();
    // AFK renders failures as an error-banner; none should survive a clean sweep.
    const banners = page.locator(".error-banner");
    await expect(banners, "no error banner").toHaveCount(0);
  });
});
