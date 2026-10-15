import { test, expect } from "./_helpers/launch";
import { seedSelectionInventory } from "./_helpers/inventory";

test.describe("contextual selection", () => {
  test("uses one search focus ring and aligns resource toolbar controls", async ({ page }) => {
    await page.locator(".primary-nav").getByRole("button", { name: /^Agents/ }).click();
    const search = page.getByRole("searchbox", { name: "搜索 Agent" });
    await search.focus();
    await search.fill("codex");
    const appearance = await search.evaluate(element => ({
      inputOutline: getComputedStyle(element).outlineStyle,
      containerShadow: getComputedStyle(element.parentElement!).boxShadow,
      searchHeight: element.parentElement!.getBoundingClientRect().height,
      segmentHeight: document.querySelector(".resource-toolbar .selection-segments")!.getBoundingClientRect().height,
    }));
    expect(appearance.inputOutline).toBe("none");
    expect(appearance.containerShadow).not.toBe("none");
    expect(Math.abs(appearance.searchHeight - appearance.segmentHeight)).toBeLessThanOrEqual(1);
    if (process.env.AFK_UI_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.AFK_UI_EVIDENCE_DIR}/agents-search.png` });
  });

  test("insets appearance choices inside their section", async ({ page }) => {
    await page.locator(".primary-nav").getByRole("button", { name: "设置", exact: true }).click();
    const spacing = await page.getByRole("radiogroup", { name: "字号密度" }).evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const section = element.closest(".settings-section")!;
      const header = section.querySelector("header")!.getBoundingClientRect();
      return { left: bounds.left - section.getBoundingClientRect().left, top: bounds.top - header.bottom };
    });
    expect(spacing.left).toBeGreaterThanOrEqual(16);
    expect(spacing.top).toBeGreaterThanOrEqual(14);
    if (process.env.AFK_UI_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.AFK_UI_EVIDENCE_DIR}/settings-light.png` });
  });

  test("discloses filters, selects an Issue source by keyboard, and removes the condition", async ({ electronApp, page }) => {
    await seedSelectionInventory(electronApp, page);
    const trigger = page.getByRole("button", { name: "筛选工作项" });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("button", { name: "选择仓库", exact: true })).toBeHidden();
    await trigger.click();
    if (process.env.AFK_UI_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.AFK_UI_EVIDENCE_DIR}/work-items-filters.png` });
    const filterBounds = await page.locator(".selection-filter-panel > .select-menu > .select-menu-trigger").evaluateAll(elements => elements.map(element => {
      const { left, right, width } = element.getBoundingClientRect();
      return { left, right, width };
    }));
    expect(filterBounds).toHaveLength(3);
    for (const bounds of filterBounds.slice(1)) {
      expect(Math.abs(bounds.width - filterBounds[0].width)).toBeLessThanOrEqual(1);
      expect(Math.abs(bounds.left - filterBounds[0].left)).toBeLessThanOrEqual(1);
      expect(Math.abs(bounds.right - filterBounds[0].right)).toBeLessThanOrEqual(1);
    }
    await expect(page.getByRole("button", { name: "筛选状态" })).toContainText("状态");
    await expect(page.getByRole("button", { name: "筛选状态" })).toContainText("全部");
    const repository = page.getByRole("button", { name: "选择仓库", exact: true });
    await repository.click();
    const repositoryPopover = repository.locator("..").locator(".select-menu-popover");
    const repositoryBounds = await repository.evaluate(element => {
      const trigger = element.getBoundingClientRect();
      const popover = element.parentElement?.querySelector<HTMLElement>(".select-menu-popover")?.getBoundingClientRect();
      return popover ? {
        trigger: { left: trigger.left, right: trigger.right, width: trigger.width },
        popover: { left: popover.left, right: popover.right, width: popover.width },
      } : null;
    });
    await expect(repositoryPopover).toBeVisible();
    expect(repositoryBounds).not.toBeNull();
    expect(Math.abs(repositoryBounds!.popover.width - repositoryBounds!.trigger.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(repositoryBounds!.popover.left - repositoryBounds!.trigger.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(repositoryBounds!.popover.right - repositoryBounds!.trigger.right)).toBeLessThanOrEqual(1);
    const search = page.getByRole("combobox", { name: "搜索 Issue 来源" });
    await search.fill("web");
    await search.press("ArrowDown");
    await search.press("Enter");
    await expect(repository).toBeFocused();
    await expect(page.locator(".backlog-row.work-item-row")).toHaveCount(1);
    await page.getByRole("button", { name: "移除筛选：Issue：acme/web" }).click();
    await expect(page.locator(".backlog-row.work-item-row")).toHaveCount(3);
    await repository.click();
    await page.getByRole("combobox", { name: "搜索 Issue 来源" }).press("Escape");
    await expect(repository).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await repository.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  test("searches pages without making a command palette the only navigation", async ({ page }) => {
    await page.getByRole("button", { name: "快速查找" }).click();
    const search = page.getByRole("combobox", { name: "搜索页面" });
    await search.fill("设置");
    await search.press("Enter");
    await expect(page.getByRole("region", { name: "外观设置" })).toBeVisible();
    await page.locator(".primary-nav").getByRole("button", { name: "工作项", exact: true }).click();
    await expect(page.getByRole("button", { name: "筛选工作项" })).toBeVisible();
  });

  test("keeps shared controls readable in graphite and within a narrow desktop viewport", async ({ electronApp, page }) => {
    await page.locator(".primary-nav").getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("radiogroup", { name: "界面主题" }).getByRole("radio", { name: "石墨" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-afk-theme", "graphite");
    await page.getByRole("radiogroup", { name: "字号密度" }).getByRole("radio", { name: "舒展" }).click();
    await page.locator(".primary-nav").getByRole("button", { name: "工作项", exact: true }).click();
    await seedSelectionInventory(electronApp, page);
    await page.setViewportSize({ width: 900, height: 800 });
    await page.getByRole("button", { name: "筛选工作项" }).click();
    const bounds = await page.getByRole("group", { name: "筛选条件" }).boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(900);
    const colors = await page.getByRole("button", { name: "选择仓库", exact: true }).evaluate(element => {
      const panel = element.closest(".selection-filter-panel")!;
      return {
        text: getComputedStyle(element).color,
        background: getComputedStyle(element).backgroundColor,
        panelBackground: getComputedStyle(panel).backgroundColor,
        searchBackground: getComputedStyle(document.querySelector(".backlog-search")!).backgroundColor,
        width: element.getBoundingClientRect().width,
        panelWidth: panel.getBoundingClientRect().width,
      };
    });
    expect(colors.text).not.toBe(colors.background);
    expect(colors.background).toBe(colors.panelBackground);
    expect(colors.searchBackground).toBe(colors.panelBackground);
    expect(colors.panelWidth - colors.width).toBeLessThanOrEqual(36);
    if (process.env.AFK_UI_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.AFK_UI_EVIDENCE_DIR}/filters-graphite-narrow.png` });
  });

  test("aligns SSH search and actions and gives filter choices the full panel width", async ({ page }) => {
    await page.locator(".primary-nav").getByRole("button", { name: "SSH 主机", exact: true }).click();
    const trigger = page.getByRole("button", { name: "筛选 SSH 主机" });
    await trigger.click();
    await expect(page.getByRole("button", { name: "来源筛选", exact: true })).toBeVisible();
    const dimensions = await trigger.evaluate(element => ({
      trigger: element.getBoundingClientRect().height,
      search: document.querySelector(".ssh-search")!.getBoundingClientRect().height,
      refresh: document.querySelector('[aria-label="刷新 SSH 主机"]')!.getBoundingClientRect().height,
    }));
    expect(dimensions.search).toBe(dimensions.trigger);
    expect(dimensions.refresh).toBe(dimensions.trigger);
    const choice = await page.getByRole("button", { name: "来源筛选", exact: true }).boundingBox();
    const panel = await page.getByRole("group", { name: "筛选条件" }).boundingBox();
    expect(panel!.width - choice!.width).toBeLessThanOrEqual(36);
    if (process.env.AFK_UI_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.AFK_UI_EVIDENCE_DIR}/ssh-filters.png` });
  });
});
