import { test } from "./_helpers/launch";

const OUT = process.env.AFK_UI_EVIDENCE_DIR ?? "/tmp/afk-shots";
const VIEWS = ["工作项", "运行中心", "工作流", "Agents", "设置"] as const;

async function setTheme(page: import("playwright").Page, label: string) {
  await page.locator(".primary-nav button", { hasText: "设置" }).click();
  await page.getByRole("radiogroup", { name: "界面主题" }).getByText(label).click();
  await page.waitForTimeout(300);
}

test.describe("reskin evidence", () => {
  for (const view of VIEWS) {
    test(`${view} (light)`, async ({ page }) => {
      await page.locator(".primary-nav button", { hasText: view }).click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/${view}-light.png` });
    });
  }

  for (const view of ["运行中心", "工作流"] as const) {
    test(`${view} (dark)`, async ({ page }) => {
      await setTheme(page, "深色");
      await page.locator(".primary-nav button", { hasText: view }).click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/${view}-dark.png` });
    });
  }
});