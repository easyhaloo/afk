import { test, expect } from "./_helpers/launch";

test.describe("Workflow studio", () => {
  test("uses an icon-only create action in the workflow library", async ({ page }) => {
    await page.getByRole("button", { name: "工作流" }).click();

    const library = page.getByRole("region", { name: "工作流列表" });
    const createButton = library.getByRole("button", { name: "新建工作流" });

    await expect(createButton).toBeVisible();
    await expect(createButton).toHaveText("");
    await expect(createButton).toHaveAttribute("title", "新建工作流");
    await expect(createButton.locator("svg")).toHaveCount(1);
  });

  test("opens a discovered workflow template on the canvas", async ({ page }) => {
    await page.getByRole("button", { name: "工作流" }).click();

    const library = page.getByRole("region", { name: "工作流列表" });
    await expect(library).toBeVisible();
    const template = library.locator(".workflow-library-card").first();
    await expect(template).toBeVisible();
    await template.click();

    await expect(page.getByLabel("工作流画布编辑器")).toBeVisible();
    await expect(page.locator(".workflow-editor-node").first()).toBeVisible();
  });
});
