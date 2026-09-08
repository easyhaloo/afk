import { test, expect } from "./_helpers/launch";

test.describe("BacklogPage list", () => {
  test.beforeEach(async ({ page }) => {
    await page.locator(".primary-nav button", { hasText: "Backlog" }).click();
  });

  test("renders the three fixture rows with localized state and execution mode", async ({ page }) => {
    await expect(page.locator(".backlog-page")).toBeVisible();

    await expect(page.getByRole("heading", { name: "Provider Backlog" })).toBeVisible();

    const rows = page.locator(".backlog-row");
    await expect(rows).toHaveCount(3);

    await expect(rows.nth(0)).toContainText("登录态切换");
    await expect(rows.nth(0)).toContainText("待处理");
    await expect(rows.nth(0)).toContainText("AFK 自动");

    await expect(rows.nth(1)).toContainText("kg 演示");
    await expect(rows.nth(1)).toContainText("进行中");
    await expect(rows.nth(1)).toContainText("AFK 自动");

    await expect(rows.nth(2)).toContainText("支付回调");
    await expect(rows.nth(2)).toContainText("已完成");
    await expect(rows.nth(2)).toContainText("HITL 人工");
  });

  test("shows the platform selector defaulting to auto", async ({ page }) => {
    const platformSelect = page.getByLabel("选择 Provider");
    await expect(platformSelect).toBeVisible();
    await expect(platformSelect).toHaveAttribute("value", "auto");
  });

  test("keeps backlog controls compact and consistently sized", async ({ page }) => {
    const platform = page.getByRole("button", { name: "选择 Provider" });
    const create = page.getByRole("button", { name: "新建 Backlog" });
    const refresh = page.getByRole("button", { name: "刷新 Backlog" });
    const search = page.locator(".backlog-search");
    const state = page.getByLabel("筛选状态");

    const controls = await Promise.all([platform, create, refresh, search, state].map(async (locator) => {
      const box = await locator.boundingBox();
      if (!box) throw new Error("Backlog control is not visible");
      return box;
    }));

    expect(controls[0].height).toBe(controls[1].height);
    expect(controls[1].height).toBe(controls[2].height);
    expect(controls[3].height).toBe(controls[4].height);
    expect(controls[0].height).toBeLessThanOrEqual(34);
    expect(controls[0].width).toBeLessThanOrEqual(150);

    await platform.click();
    const popover = page.getByRole("listbox", { name: "选择 Provider" });
    const menuBox = await popover.boundingBox();
    const triggerBox = await platform.boundingBox();
    if (!menuBox || !triggerBox) throw new Error("Provider menu is not visible");
    expect(Math.abs(menuBox.width - triggerBox.width)).toBeLessThanOrEqual(2);

    const optionBoxes = await page.getByRole("option").evaluateAll((options) => options.map((option) => option.getBoundingClientRect().height));
    expect(Math.max(...optionBoxes)).toBeLessThanOrEqual(34);
  });

  test("uses the application green palette for backlog controls", async ({ page }) => {
    const platform = page.getByRole("button", { name: "选择 Provider" });
    await platform.click();

    const colors = await page.evaluate(() => {
      const normalize = (color: string) => {
        const probe = document.createElement("span");
        probe.style.color = color;
        document.body.appendChild(probe);
        const normalized = getComputedStyle(probe).color;
        probe.remove();
        return normalized;
      };
      const root = getComputedStyle(document.documentElement);
      const trigger = getComputedStyle(document.querySelector<HTMLElement>('.select-menu-trigger[aria-label="选择 Provider"]')!);
      const popover = getComputedStyle(document.querySelector<HTMLElement>('.select-menu-popover[aria-label="选择 Provider"]')!);
      const tag = getComputedStyle(document.querySelector<HTMLElement>(".backlog-tags li")!);
      return {
        run: normalize(root.getPropertyValue("--run").trim()),
        line: normalize(root.getPropertyValue("--line").trim()),
        ink: normalize(root.getPropertyValue("--ink").trim()),
        triggerBorder: trigger.borderTopColor,
        triggerText: trigger.color,
        popoverBorder: popover.borderTopColor,
        tagText: tag.color,
      };
    });

    expect(colors.triggerBorder).toBe(colors.run);
    expect(colors.triggerText).toBe(colors.ink);
    expect(colors.popoverBorder).toBe(colors.line);
    expect(colors.tagText).toBe(colors.run);
  });

  test("opens a right-side detail preview for a backlog row", async ({ page }) => {
    await page.locator(".backlog-row").first().click();
    const drawer = page.getByRole("dialog", { name: "登录态切换" });
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText("切换登录态并保留当前工作区。");
    await expect(drawer.getByRole("button", { name: "在浏览器中打开" })).toBeVisible();
    await drawer.getByRole("button", { name: "关闭详情" }).click();
    await expect(page.getByRole("dialog", { name: "登录态切换" })).toHaveCount(0);
  });

  test("filters rows by query string", async ({ page }) => {
    const search = page.getByLabel("搜索 Backlog");
    await search.fill("kg");
    await expect(page.locator(".backlog-row")).toHaveCount(1);
    await expect(page.locator(".backlog-row").first()).toContainText("kg 演示");
  });

  test("filters rows by state via the custom state menu", async ({ page }) => {
    await page.getByLabel("筛选状态").click();
    await page.getByRole("option", { name: "已完成" }).click();
    await expect(page.locator(".backlog-row")).toHaveCount(1);
    await expect(page.locator(".backlog-row").first()).toContainText("支付回调");
  });
});
