import { test } from "./_helpers/launch";

const OUT = process.env.AFK_UI_EVIDENCE_DIR ?? "/tmp/afk-shots";
const VIEWS = ["工作项", "运行中心", "工作流", "Agents", "设置"] as const;

async function setTheme(page: import("@playwright/test").Page, label: string) {
  await page.locator(".primary-nav button", { hasText: "设置" }).click();
  await page.getByRole("radiogroup", { name: "界面主题" }).getByText(label).click();
  await page.waitForTimeout(300);
}

test.describe("reskin evidence", () => {
  for (const view of VIEWS) {
    test(`${view} (light)`, async ({ page }) => {
      // The default theme is now dark, so light must be selected explicitly —
      // otherwise every "light" shot is silently dark.
      await setTheme(page, "浅色");
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

  // 代码仓库 evidence shots — row-item layout and toolbar order per prototype
  for (const label of ["浅色", "深色"] as const) {
    test(`代码仓库 (${label})`, async ({ page }) => {
      await setTheme(page, label);
      await page.locator(".primary-nav button", { hasText: "代码仓库" }).click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/代码仓库-${label}.png` });
    });
  }

  // 字号密度 scales every font size, so a row with a fixed height can clip at
  // ×1.1 in a way nothing else would notice. 工作流 is the densest surface.
  for (const view of ["工作流", "工作项"] as const) {
    test(`${view} (舒展)`, async ({ page }) => {
      await setTheme(page, "浅色");
      await page.locator(".primary-nav button", { hasText: "设置" }).click();
      await page.getByRole("radiogroup", { name: "字号密度" }).getByText("舒展").click();
      await page.waitForTimeout(250);
      await page.locator(".primary-nav button", { hasText: view }).click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/${view}-large.png` });
    });
  }

  // The canvas is the most complex surface in the app and was never
  // photographed, which is how it stayed invisible behind eleven green tests.
  test("工作流画布 (light)", async ({ page }) => {
    await setTheme(page, "浅色");
    await page.locator(".primary-nav button", { hasText: "工作流" }).click();
    await page.waitForTimeout(400);
    await page.locator(".workflow-library-card").first().click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/工作流画布-light.png` });
  });

  // Nothing else in this suite opens an overlay, so a modal or drawer that
  // silently changes width would pass every other test in the package.
  test("执行工作项模态 (light)", async ({ page }) => {
    await setTheme(page, "浅色");
    await page.locator(".primary-nav button", { hasText: "工作项" }).click();
    await page.waitForTimeout(400);
    const row = page.locator(".work-item-row").first();
    test.skip((await row.count()) === 0, "no work item rows in the fixture");
    await row.click();
    await page.waitForTimeout(400);
    await page.locator(".work-item-primary-action").click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/执行工作项-modal-light.png` });
  });
});