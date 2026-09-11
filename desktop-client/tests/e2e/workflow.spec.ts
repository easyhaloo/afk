import { test, expect } from "./_helpers/launch";

test.describe("Workflow studio", () => {
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
