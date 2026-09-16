import { test, expect } from "./_helpers/launch";

test.describe("BacklogPage list", () => {
  test.beforeEach(async ({ page }) => {
    await page.locator(".primary-nav button", { hasText: "Backlog" }).click();
  });

  test("keeps the page header without global actions", async ({ page }) => {
    await expect(page.locator(".topbar")).toBeVisible();
    await expect(page.getByRole("button", { name: "刷新页面" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /命令/ })).toHaveCount(0);
  });

  test("renders the three fixture rows with localized state and a leading mode icon", async ({ page }) => {
    await expect(page.locator(".backlog-page")).toBeVisible();

    await expect(page.getByRole("heading", { name: "Provider Backlog" })).toBeVisible();

    const rows = page.locator(".backlog-row");
    await expect(rows).toHaveCount(3);

    await expect(rows.nth(0)).toContainText("登录态切换");
    await expect(rows.nth(0)).toContainText("待处理");
    await expect(rows.nth(0).locator(".backlog-mode-mark")).toHaveAttribute("aria-label", "AFK 自动");

    await expect(rows.nth(1)).toContainText("kg 演示");
    await expect(rows.nth(1)).toContainText("进行中");
    await expect(rows.nth(1).locator(".backlog-mode-mark")).toHaveAttribute("aria-label", "AFK 自动");

    await expect(rows.nth(2)).toContainText("支付回调");
    await expect(rows.nth(2)).toContainText("已完成");
    await expect(rows.nth(2).locator(".backlog-mode-mark")).toHaveAttribute("aria-label", "HITL 人工");
  });

  test("shows the platform selector defaulting to auto", async ({ page }) => {
    const platformSelect = page.getByLabel("选择 Provider");
    await expect(platformSelect).toBeVisible();
    await expect(platformSelect).toHaveAttribute("value", "auto");
  });

  test("keeps backlog controls compact and consistently sized", async ({ page }) => {
    const platform = page.getByRole("button", { name: "选择 Provider" });
    const create = page.getByRole("button", { name: "新建 Backlog" });
    const search = page.locator(".backlog-search");
    const state = page.getByLabel("筛选状态");

    await expect(page.getByRole("button", { name: "刷新 Backlog" })).toHaveCount(0);

    const controls = await Promise.all([platform, create, search, state].map(async (locator) => {
      const box = await locator.boundingBox();
      if (!box) throw new Error("Backlog control is not visible");
      return box;
    }));

    expect(controls[0].height).toBe(controls[1].height);
    expect(controls[2].height).toBe(controls[3].height);
    expect(controls[0].height).toBeLessThanOrEqual(34);
    expect(controls[0].width).toBe(120);

    const providerAlignment = await platform.evaluate((button) => {
      const buttonBox = button.getBoundingClientRect();
      const labelBox = button.querySelector("span")!.getBoundingClientRect();
      const iconBox = button.querySelector("svg")!.getBoundingClientRect();
      return {
        labelLeftOffset: labelBox.left - buttonBox.left,
        iconRightOffset: buttonBox.right - iconBox.right,
        labelIconGap: iconBox.left - labelBox.right,
      };
    });
    const stateAlignment = await state.evaluate((button) => {
      const buttonBox = button.getBoundingClientRect();
      const labelBox = button.querySelector("span")!.getBoundingClientRect();
      const iconBox = button.querySelector("svg")!.getBoundingClientRect();
      return {
        labelLeftOffset: labelBox.left - buttonBox.left,
        iconRightOffset: buttonBox.right - iconBox.right,
      };
    });
    expect(Math.abs(providerAlignment.labelLeftOffset - stateAlignment.labelLeftOffset)).toBeLessThanOrEqual(1);
    expect(Math.abs(providerAlignment.iconRightOffset - stateAlignment.iconRightOffset)).toBeLessThanOrEqual(1);
    expect(providerAlignment.labelIconGap).toBeGreaterThanOrEqual(20);

    await platform.click();
    const popover = page.getByRole("listbox", { name: "选择 Provider" });
    const menuBox = await popover.boundingBox();
    const triggerBox = await platform.boundingBox();
    if (!menuBox || !triggerBox) throw new Error("Provider menu is not visible");
    expect(Math.abs(menuBox.width - triggerBox.width)).toBeLessThanOrEqual(2);

    const optionBoxes = await page.getByRole("option").evaluateAll((options) => options.map((option) => option.getBoundingClientRect().height));
    expect(Math.max(...optionBoxes)).toBeLessThanOrEqual(34);
    await expect(page.getByRole("option").first()).toHaveCSS("text-align", "left");
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

    await expect.poll(async () => page.locator('.select-menu-trigger[aria-label="选择 Provider"]').evaluate((element) => getComputedStyle(element).borderTopColor)).toBe(colors.run);
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

  test("renders the execution mode as a leading icon mark only", async ({ page }) => {
    const rows = page.locator(".backlog-row");
    const afkMark = rows.nth(0).locator(".backlog-mode-mark");
    const hitlMark = rows.nth(2).locator(".backlog-mode-mark");

    await expect(afkMark).toHaveClass(/is-afk/);
    await expect(afkMark.locator("svg")).toHaveCount(1);
    await expect(rows.nth(0).locator(".backlog-mode-tag")).toHaveCount(0);

    await expect(hitlMark).toHaveClass(/is-hitl/);
    await expect(hitlMark.locator("svg")).toHaveCount(1);
    await expect(rows.nth(2).locator(".backlog-mode-tag")).toHaveCount(0);

    const colors = await page.evaluate(() => {
      const resolveColor = (name: string) => {
        const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        const probe = document.createElement("span");
        probe.style.color = value;
        document.body.appendChild(probe);
        const normalized = getComputedStyle(probe).color;
        probe.remove();
        return normalized;
      };
      const readMark = (index: number) => {
        const rowList = document.querySelectorAll<HTMLElement>(".backlog-row");
        const mark = rowList[index]?.querySelector<HTMLElement>(".backlog-mode-mark");
        if (!mark) throw new Error(`missing mode mark at row ${index}`);
        const style = getComputedStyle(mark);
        return { color: style.color };
      };
      return {
        run: resolveColor("--run"),
        attention: resolveColor("--attention"),
        afk: readMark(0),
        hitl: readMark(2),
      };
    });

    expect(colors.afk.color).toBe(colors.run);
    expect(colors.hitl.color).toBe(colors.attention);
    expect(colors.afk.color).not.toBe(colors.hitl.color);
  });

  test("shows the leading mode mark plus a tag inside the detail drawer", async ({ page }) => {
    await page.locator(".backlog-row").first().click();
    const drawer = page.getByRole("dialog", { name: "登录态切换" });
    await expect(drawer).toBeVisible();

    const mark = drawer.locator(".backlog-mode-mark");
    const tag = drawer.locator(".backlog-mode-tag");
    await expect(mark).toHaveClass(/is-afk/);
    await expect(mark.locator("svg")).toHaveCount(1);
    await expect(tag).toHaveClass(/is-afk/);
    await expect(tag).toContainText("AFK 自动");
  });
});
