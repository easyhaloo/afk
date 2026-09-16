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

  test("pans the workflow canvas by dragging its empty surface", async ({ page }) => {
    await page.getByRole("button", { name: "工作流" }).click();
    await page.locator(".workflow-library-card").first().click();

    const stage = page.locator(".workflow-editor-stage");
    const world = page.locator(".workflow-editor-world");
    const stageBox = await stage.boundingBox();
    if (!stageBox) throw new Error("workflow canvas stage is not measurable");
    const before = await world.evaluate((element) => getComputedStyle(element).transform);

    await page.mouse.move(stageBox.x + 48, stageBox.y + stageBox.height - 52);
    await page.mouse.down();
    await page.mouse.move(stageBox.x + 128, stageBox.y + stageBox.height - 22);
    await page.mouse.up();

    await expect(world).not.toHaveCSS("transform", before);
    await expect(stage).not.toHaveClass(/is-panning/);
  });

  test("zooms the workflow canvas with the mouse wheel", async ({ page }) => {
    await page.getByRole("button", { name: "工作流" }).click();
    await page.locator(".workflow-library-card").first().click();

    const stage = page.locator(".workflow-editor-stage");
    const zoomLabel = page.locator(".workflow-canvas-controls span");
    const stageBox = await stage.boundingBox();
    if (!stageBox) throw new Error("workflow canvas stage is not measurable");
    const before = await zoomLabel.textContent();

    await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
    await page.mouse.wheel(0, -180);

    await expect(zoomLabel).not.toHaveText(before ?? "");
  });

  test("drags a built-in workflow node", async ({ page }) => {
    await page.getByRole("button", { name: "工作流" }).click();
    await page.locator(".workflow-library-card").first().click();

    const node = page.locator(".workflow-editor-node").nth(1);
    await page.locator(".workflow-editor-world").evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
    const beforeBox = await node.boundingBox();
    if (!beforeBox) throw new Error("built-in workflow node is not measurable");
    const before = await node.evaluate((element) => ({ left: parseFloat((element as HTMLElement).style.left), top: parseFloat((element as HTMLElement).style.top) }));

    await page.mouse.move(beforeBox.x + beforeBox.width / 2, beforeBox.y + beforeBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(beforeBox.x + beforeBox.width / 2 + 80, beforeBox.y + beforeBox.height / 2 + 40);
    await page.mouse.up();

    const after = await node.evaluate((element) => ({ left: parseFloat((element as HTMLElement).style.left), top: parseFloat((element as HTMLElement).style.top) }));
    expect(Math.abs(after.left - before.left)).toBeGreaterThan(30);
    expect(Math.abs(after.top - before.top)).toBeGreaterThan(15);
  });

  test("fills the remaining viewport instead of leaving a bottom gap", async ({ page }) => {
    await page.getByRole("button", { name: "工作流" }).click();
    await page.locator(".workflow-library-card").first().click();

    const pageBox = await page.locator(".workflow-studio-page").boundingBox();
    const workspaceBox = await page.locator(".workspace").boundingBox();
    if (!pageBox || !workspaceBox) throw new Error("workflow studio layout is not measurable");
    expect(Math.abs(pageBox.y + pageBox.height - (workspaceBox.y + workspaceBox.height))).toBeLessThanOrEqual(2);
  });

  test("uses the available editor width instead of collapsing the canvas", async ({ page }) => {
    await page.getByRole("button", { name: "工作流" }).click();
    await page.locator(".workflow-library-card").first().click();

    const pageBox = await page.locator(".workflow-studio-page").boundingBox();
    const canvasBox = await page.locator(".workflow-studio-canvas").boundingBox();
    if (!pageBox || !canvasBox) throw new Error("workflow studio width is not measurable");
    expect(canvasBox.width / pageBox.width).toBeGreaterThanOrEqual(0.75);
  });

  test("uses one icon-only add trigger with clearly labeled step choices", async ({ page }) => {
    await page.getByRole("button", { name: "工作流" }).click();
    await page.locator(".workflow-library-card").first().click();

    const toolbar = page.locator(".workflow-studio-toolbar");
    const trigger = toolbar.getByRole("button", { name: "添加工作流步骤" });
    await expect(trigger).toHaveText("");
    await expect(trigger.locator("svg")).toHaveCount(1);
    await expect(toolbar.getByRole("button")).toHaveCount(1);

    await trigger.click();
    const menu = page.getByRole("menu", { name: "添加工作流步骤" });
    await expect(menu.getByRole("menuitem", { name: "添加 Agent 步骤" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "添加 QA 步骤" })).toBeVisible();
  });

  test("keeps workflow inspector select menus opaque above the following fields", async ({ page }) => {
    await page.getByRole("button", { name: "工作流" }).click();
    await page.locator(".workflow-library-card").first().click();
    await page.locator(".workflow-editor-node").filter({ hasText: "开始" }).click();

    const trigger = page.getByRole("button", { name: "默认 Agent" });
    await trigger.click();

    const menu = page.getByRole("listbox", { name: "默认 Agent" });
    await expect(menu).toBeVisible();
    await expect(menu).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(menu).toHaveCSS("border-top-width", "1px");
    await expect(menu.locator('[role="option"]')).toHaveCount(6);
  });

  test("uses compact workflow library controls and a quiet current-template status", async ({ page }) => {
    await page.getByRole("button", { name: "工作流" }).click();

    const createButton = page.getByRole("button", { name: "新建工作流" });
    const createBox = await createButton.boundingBox();
    if (!createBox) throw new Error("workflow create control is not measurable");
    expect(createBox.width).toBeLessThanOrEqual(30);
    expect(createBox.height).toBeLessThanOrEqual(30);

    let activeCard = page.locator(".workflow-library-card.active");
    if (await activeCard.count() === 0) {
      await page.locator(".workflow-library-card").first().click();
      await page.getByRole("button", { name: "保存", exact: true }).first().click();
      await page.getByRole("button", { name: "工作流", exact: true }).last().click();
      activeCard = page.locator(".workflow-library-card.active");
    }

    await expect(activeCard.locator(".workflow-library-card-status")).toHaveText("当前模板");
    await expect(activeCard.locator(".workflow-library-card-status")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  });

  test("uses compact studio controls and inline node state labels", async ({ page }) => {
    await page.getByRole("button", { name: "工作流" }).click();
    await page.locator(".workflow-library-card").first().click();

    const saveButton = page.getByRole("button", { name: "保存", exact: true }).first();
    const addButton = page.getByRole("button", { name: "添加工作流步骤" });
    const saveBox = await saveButton.boundingBox();
    const addBox = await addButton.boundingBox();
    if (!saveBox || !addBox) throw new Error("workflow controls are not measurable");
    expect(saveBox.height).toBeLessThanOrEqual(28);
    expect(addBox.width).toBeLessThanOrEqual(28);
    expect(addBox.height).toBeLessThanOrEqual(28);

    const nodeStatus = page.locator(".workflow-editor-node .workflow-node-status").first();
    await expect(nodeStatus).toBeVisible();
    await expect(nodeStatus).toHaveText(/就绪|运行中|已完成|待执行/);
    await expect(nodeStatus).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  });
});
