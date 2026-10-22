import { test, expect } from "./_helpers/launch.js";
import { navButton } from "./_helpers/nav.js";
import { seedSelectionInventory } from "./_helpers/inventory.js";
import { IPC_CHANNELS } from "../../shared/ipc-contract.js";
import { parseWorkItemInventoryResult } from "../../shared/backlog-contract.js";
import { INVENTORY } from "./fixtures/provider-inventory.mjs";
import type { ElectronApplication, Page } from "playwright";

/**
 * The shared fixture carries no update timestamp, so the sort behaviour gets
 * its own inventory: three dated base items plus a bulk of paginated ones.
 */
const BASE_ITEMS = [
  { id: "github:acme/api#1", issueNumber: 1, project: { platform: "github", projectKey: "acme/api", name: "api", defaultBranch: "main" }, title: "API 登录态切换", description: "跨仓库 API 工作项。", managed: true, executionEligible: true, state: "ready", executionMode: "afk", dependsOn: [], tags: ["billing"], branchName: "afk/backlog-1", providerRef: "github:acme/api#1", updatedAt: "2026-01-01T00:00:00.000Z" },
  { id: "github:acme/web#1", issueNumber: 1, project: { platform: "github", projectKey: "acme/web", name: "web", defaultBranch: "main" }, title: "Web 登录页调整", description: "同号但属于另一个仓库。", managed: false, executionEligible: false, state: "ready", executionMode: "hitl", dependsOn: [], tags: ["frontend"], branchName: "afk/backlog-1", providerRef: "github:acme/web#1", updatedAt: "2026-10-01T00:00:00.000Z" },
  { id: "github:acme/api#99", issueNumber: 99, project: { platform: "github", projectKey: "acme/api", name: "api", defaultBranch: "main" }, title: "早期 API 调整", description: "早期工作项。", managed: false, executionEligible: false, state: "ready", executionMode: "afk", dependsOn: [], tags: [], branchName: "afk/backlog-99", providerRef: "github:acme/api#99", updatedAt: "2025-06-15T00:00:00.000Z" },
];

const PAGINATED_ITEMS = Array.from({ length: 55 }, (_, index) => {
  const month = String(Math.min(9, (index % 9) + 2));
  return {
    id: `github:acme/api#${index + 10}`,
    issueNumber: index + 10,
    project: { platform: "github", projectKey: "acme/api", name: "api", defaultBranch: "main" },
    title: `批量填充项目 ${index + 10}`,
    description: "用于加载更多测试。",
    managed: false,
    executionEligible: false,
    state: "ready" as const,
    executionMode: "afk" as const,
    dependsOn: [],
    tags: [],
    branchName: `afk/backlog-${index + 10}`,
    providerRef: `github:acme/api#${index + 10}`,
    updatedAt: `2026-${month.padStart(2, '0')}-01T00:00:00.000Z`,
  };
});

function buildPaginatedInventory() {
  return parseWorkItemInventoryResult({
    items: [...BASE_ITEMS, ...PAGINATED_ITEMS],
    projects: [
      { platform: "github", projectKey: "acme/api", name: "api", defaultBranch: "main" },
      { platform: "github", projectKey: "acme/web", name: "web", defaultBranch: "main" },
    ],
    diagnostics: [],
    complete: true,
  });
}

async function seedPaginatedInventory(electronApp: ElectronApplication, page: Page) {
  const inventory = buildPaginatedInventory();
  await electronApp.evaluate(({ ipcMain }, input) => {
    ipcMain.removeHandler(input.channel);
    ipcMain.handle(input.channel, () => input.inventory);
  }, { channel: IPC_CHANNELS.workItemsList, inventory });
  await page.getByRole("button", { name: "刷新工作项" }).click();
}

test.describe("global work items", () => {
  test.beforeEach(async ({ electronApp, page }) => { await seedSelectionInventory(electronApp, page); });
  test("shows same-number issues from different repositories without selecting a directory", async ({ page }) => {
    const rows = page.locator(".backlog-row.work-item-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator(".work-item-source-summary").getByLabel("GitHub")).toBeVisible();
    await expect(rows.nth(0).locator(".work-item-source-summary")).not.toContainText("GitHub Issue");
    await expect(rows.nth(0)).toContainText("acme/api");
    await expect(rows.nth(1)).toContainText("acme/web");
    await expect(rows.nth(0)).toContainText("#1");
    await expect(rows.nth(1)).toContainText("#1");
    await expect(rows.nth(1)).toContainText("待导入");
    const sourceReference = rows.nth(0).locator(".work-item-source-summary > span:not(.work-item-platform-icon)");
    expect(await sourceReference.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  });

  test("filters the global inventory by project", async ({ page }) => {
    await page.getByRole("button", { name: "筛选工作项" }).click();
    const providerTrigger = page.getByLabel("选择 Provider");
    const projectTrigger = page.getByLabel("选择仓库");
    await expect(providerTrigger).toHaveCSS("white-space", "normal");
    await expect(providerTrigger.locator(".select-menu-trigger-value")).toHaveCSS("white-space", "nowrap");
    await expect(projectTrigger.locator(".select-menu-trigger-value")).toHaveCSS("white-space", "nowrap");

    await projectTrigger.click();
    const sourceSearch = page.getByLabel("搜索 Issue 来源");
    await expect(sourceSearch).toBeVisible();
    await expect(page.locator(".select-menu-options")).toHaveCSS("overflow-y", "auto");
    await sourceSearch.fill("web");
    await expect(page.getByRole("option", { name: "全部 Issue 来源" })).toBeVisible();
    await expect(page.getByRole("option", { name: "acme/api" })).toHaveCount(0);
    await page.getByRole("option", { name: "acme/web" }).click();
    await expect(page.locator(".backlog-row.work-item-row")).toHaveCount(1);
    await expect(page.locator(".backlog-row.work-item-row")).toContainText("Web 登录页调整");
  });

  test("business tags stay distinct and wrap within the row in both themes", async ({ electronApp, page }) => {
    const tags = ["desktop-observability validation", "frontend", "validation-".repeat(16)];
    const inventory = structuredClone(INVENTORY);
    inventory.items[0].tags = tags;
    inventory.items[1].tags = [];
    await electronApp.evaluate(({ ipcMain }, { channel, inventory }) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => inventory);
    }, { channel: IPC_CHANNELS.workItemsList, inventory });
    for (const theme of ["浅色", "深色"]) {
      await navButton(page, "设置").click();
      await page.getByRole("radiogroup", { name: "界面主题" }).getByText(theme).click();
      await page.locator(".primary-nav").getByRole("button", { name: "工作项", exact: true }).click();
      await page.getByRole("button", { name: "刷新工作项" }).click();
      const rows = page.locator(".work-item-row");
      const labels = rows.first().getByRole("list", { name: "工作项标签" });
      await expect(labels.getByRole("listitem")).toHaveCount(3);
      await expect(rows.nth(1).getByRole("list", { name: "工作项标签" })).toHaveCount(0);
      for (const [width, height] of [[1440, 920], [800, 800]]) {
        await electronApp.evaluate(({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]);
        }, [width, height]);
        const label = labels.getByRole("listitem").first();
        await expect(label).toHaveCSS("border-top-left-radius", "2px");
        await expect(label.locator("svg")).toBeVisible();
        await expect(label).toHaveAttribute("title", tags[0]);
        await expect.poll(() => labels.evaluate(element =>
          [...element.querySelectorAll("li")].every(tag => tag.scrollWidth <= tag.clientWidth)
          && element.getBoundingClientRect().top >= element.previousElementSibling!.getBoundingClientRect().bottom
          && document.documentElement.scrollWidth <= window.innerWidth,
        )).toBe(true);
        if (process.env.AFK_UI_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.AFK_UI_EVIDENCE_DIR}/work-item-tags-${theme}-${width}.png`, animations: "disabled" });
      }
    }
  });

  test("sort selector reverses row order and persists across filter and load-more", async ({ electronApp, page }) => {
    await seedPaginatedInventory(electronApp, page);

    const rows = page.locator(".backlog-row.work-item-row");
    await expect(rows).toHaveCount(50);
    await expect(rows.nth(0)).toContainText("Web 登录页调整");

    const sortTrigger = page.getByRole("button", { name: "排序" });
    await sortTrigger.click();
    await page.getByRole("option", { name: "最早更新优先" }).click();

    await expect(rows.nth(0)).toContainText("早期 API 调整");
    await expect(rows.nth(1)).toContainText("API 登录态切换");
    const sortTriggerValueAfterSelect = sortTrigger.locator(".select-menu-trigger-value");
    await expect(sortTriggerValueAfterSelect).toContainText("最早更新优先");

    await page.getByRole("button", { name: "筛选工作项" }).click();
    await page.getByLabel("选择仓库").click();
    await page.getByRole("option", { name: "acme/api" }).click();
    await expect(page.getByRole("button", { name: "显示更多工作项" })).toBeVisible();
    await expect(sortTriggerValueAfterSelect).toContainText("最早更新优先");

    await page.getByRole("button", { name: "显示更多工作项" }).click();
    await expect(rows).toHaveCount(57);
    await expect(rows.first()).toContainText("早期 API 调整");
    await expect(sortTriggerValueAfterSelect).toContainText("最早更新优先");
  });

  test("sort selector keyboard and accessibility", async ({ page }) => {
    const sortTrigger = page.getByRole("button", { name: "排序" });
    await sortTrigger.click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await sortTrigger.press("Escape");
    await expect(page.getByRole("listbox")).not.toBeVisible();
    const rows = page.locator(".backlog-row.work-item-row");
    await rows.first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("sort selection persists across search, provider, state, and refresh", async ({ electronApp, page }) => {
    await seedPaginatedInventory(electronApp, page);

    const rows = page.locator(".backlog-row.work-item-row");
    await expect(rows.first()).toContainText("Web 登录页调整");

    const sortTrigger = page.getByRole("button", { name: "排序" });
    const sortTriggerValue = sortTrigger.locator(".select-menu-trigger-value");
    await sortTrigger.click();
    await page.getByRole("option", { name: "最早更新优先" }).click();
    await expect(sortTriggerValue).toContainText("最早更新优先");
    await expect(rows.first()).toContainText("早期 API 调整");

    await page.locator("[aria-label=\"搜索工作项\"]").fill("API");
    await expect(sortTriggerValue).toContainText("最早更新优先");
    await page.locator("[aria-label=\"搜索工作项\"]").fill("");

    await page.getByRole("button", { name: "筛选工作项" }).click();
    await page.getByLabel("选择 Provider").click();
    await page.getByRole("option", { name: "GitHub" }).click();
    await expect(sortTriggerValue).toContainText("最早更新优先");

    await page.getByLabel("筛选状态").click();
    await page.getByRole("option", { name: "待处理" }).click();
    await expect(sortTriggerValue).toContainText("最早更新优先");

    await page.getByRole("button", { name: "刷新工作项" }).click();
    await expect(sortTriggerValue).toContainText("最早更新优先");
    await expect(rows.first()).toContainText("早期 API 调整");
  });
});
