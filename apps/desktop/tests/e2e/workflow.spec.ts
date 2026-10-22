import { test, expect } from "./_helpers/launch.js";
import { navButton } from "./_helpers/nav.js";
import { expectOccupiesSpace } from "./_helpers/geometry.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

test.describe("Workflow studio", () => {
  test("shows real parallel dependencies in a separate inspector without a footer", async ({ page }) => {
    const snapshot = await page.evaluate(() => window.afkDesktop.snapshot(""));
    const directory = path.join(snapshot.workspace.root, ".afk", "workflows");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "parallel-layout.yml"), JSON.stringify({
      name: "parallel-layout", version: 1, description: "Parallel workflow layout regression",
      steps: [
        { id: "implement", kind: "agent", role: "implementer", dependsOn: [] },
        { id: "verify-ac", kind: "agent", role: "verifier", dependsOn: ["implement"] },
        { id: "review", kind: "agent", role: "reviewer", dependsOn: ["implement"] },
        { id: "publish", kind: "system", role: "system", action: "publish-changes", dependsOn: ["verify-ac", "review"] },
        { id: "queue-qa", kind: "system", role: "system", action: "queue-qa", dependsOn: ["publish"] },
      ],
    }));
    await page.reload();
    await navButton(page, "设置").click();
    await page.getByRole("radiogroup", { name: "界面主题" }).getByRole("radio", { name: "浅色" }).click();
    await page.locator(".primary-nav").getByRole("button", { name: "工作流", exact: true }).click();
    await page.locator(".workflow-library-card").filter({ hasText: "parallel-layout" }).click();
    await expect(page.locator(".workflow-editor-node")).toHaveCount(6);
    await expect(page.locator(".workflow-edge")).toHaveCount(6);
    await expect(page.locator(".workflow-studio-canvas > footer")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "保存", exact: true })).toHaveCount(1);
    const inspector = page.locator(".workflow-studio-shell > .workflow-studio-inspector");
    await expect(inspector).toBeVisible();
    const publish = page.locator(".workflow-editor-node").filter({ hasText: "publish" });
    await publish.click();
    const dependencies = page.getByRole("region", { name: "前置依赖", exact: true });
    await expect(dependencies.locator(".workflow-dependency-chip")).toHaveText(["verify-ac", "review"]);
    await expect(dependencies.locator("p")).toHaveText("全部依赖完成后执行。");
    await expect(dependencies.locator("svg")).toHaveCount(0);
    for (const width of [1680, 1280, 1024]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect.poll(() => page.locator(".workflow-editor-stage").evaluate(stage => {
        const bounds = stage.getBoundingClientRect();
        return [...stage.querySelectorAll(".workflow-editor-node")].every(node => {
          const box = node.getBoundingClientRect();
          return box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom;
        });
      })).toBe(true);
      const canvasBox = await page.locator(".workflow-studio-canvas").boundingBox();
      const inspectorBox = await inspector.boundingBox();
      expect(canvasBox!.x + canvasBox!.width).toBeLessThanOrEqual(inspectorBox!.x + 1);
      expect(await dependencies.evaluate(section => [...section.querySelectorAll(".workflow-dependency-chip")].every(chip => chip.getBoundingClientRect().bottom <= section.querySelector("p")!.getBoundingClientRect().top))).toBe(true);
      if (process.env.AFK_UI_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.AFK_UI_EVIDENCE_DIR}/workflow-layout-${width}.png` });
    }
    await page.getByRole("button", { name: "收起配置栏", exact: true }).click();
    await expect(inspector).toHaveCount(0);
    await page.getByRole("button", { name: "展开配置栏", exact: true }).click();
    await expect(inspector).toBeVisible();
  });

  test("rejects saving an empty managed draft and reopens the last saved definition", async ({ page }) => {
    await page.locator(".primary-nav").getByRole("button", { name: "工作流", exact: true }).click();
    await page.getByRole("button", { name: "新建工作流" }).click();
    await page.getByRole("button", { name: "添加工作流步骤" }).click();
    await page.getByRole("menuitem", { name: "添加 Agent 步骤" }).click();
    const save = page.getByRole("button", { name: "保存", exact: true }).first();
    await save.click();
    await expect(save).toBeDisabled();
    const saved = await page.evaluate(() => window.afkDesktop.snapshot(""));
    expect(saved.workflow.canvasNodes).toHaveLength(1);
    const savedId = saved.workflow.canvasNodes[0].id;

    await page.getByRole("button", { name: "移除节点", exact: true }).click();
    await expect(page.locator(".workflow-editor-node:not(.origin-node)")).toHaveCount(0);
    await save.click();
    await expect(page.getByRole("alert")).toContainText("自定义工作流至少需要一个步骤");
    await expect(page.locator(".workflow-dirty")).toBeVisible();
    const unchanged = await page.evaluate(() => window.afkDesktop.snapshot(""));
    expect(unchanged.workflow.canvasNodes.map(node => node.id)).toEqual([savedId]);
    expect(unchanged.workflowTemplates.find(template => template.id === "afk-control-workflow")?.steps.map(step => step.id)).toEqual([savedId]);

    await page.locator(".workflow-back").click();
    await page.locator(".workflow-library-card").filter({ hasText: "自定义工作流" }).click();
    await expect(page.locator(".workflow-editor-node.custom-node")).toHaveCount(1);
    await page.locator(".workflow-editor-node.custom-node").click();
    await page.getByRole("button", { name: "移除节点", exact: true }).click();
    await page.getByRole("button", { name: "添加工作流步骤" }).click();
    await page.getByRole("menuitem", { name: "添加审查 Agent" }).click();
    await save.click();
    await expect(save).toBeDisabled();
    const replaced = await page.evaluate(() => window.afkDesktop.snapshot(""));
    expect(replaced.workflow.canvasNodes).toHaveLength(1);
    expect(replaced.workflow.canvasNodes[0].id).not.toBe(savedId);
    expect(replaced.workflowTemplates.find(template => template.id === "afk-control-workflow")?.steps).toMatchObject([
      { id: replaced.workflow.canvasNodes[0].id, role: "reviewer", dependsOn: [] },
    ]);
    await page.reload();
    await page.locator(".primary-nav").getByRole("button", { name: "工作流", exact: true }).click();
    await page.locator(".workflow-library-card").filter({ hasText: "自定义工作流" }).click();
    await expect(page.locator(".workflow-editor-node.custom-node")).toHaveCount(1);
    await expect(page.locator(".workflow-editor-node.custom-node")).toContainText("审查 Agent");
    await page.locator(".workflow-back").click();
    await page.locator(".workflow-library-card").filter({ hasText: "Issue 实现" }).click();
    await save.click();
    await expect(save).toBeDisabled();
    await page.locator(".workflow-back").click();
    await page.locator(".workflow-library-card").filter({ hasText: "自定义工作流" }).click();
    await expect(page.locator(".workflow-editor-node.custom-node")).toHaveCount(1);
    await expect(page.locator(".workflow-editor-node.custom-node")).toContainText("审查 Agent");
    await save.click();
    await expect(save).toBeDisabled();
    const reselected = await page.evaluate(() => window.afkDesktop.snapshot(""));
    expect(reselected.workflow.templateName).toBe("afk-control-workflow");
    expect(reselected.workflow.canvasNodes).toEqual(replaced.workflow.canvasNodes);
  });

  test("does not add an unsaved draft to the workflow library", async ({ page }) => {
    await page.locator(".primary-nav").getByRole("button", { name: "工作流", exact: true }).click();
    await page.getByRole("button", { name: "新建工作流" }).click();
    await page.getByRole("button", { name: "添加工作流步骤" }).click();
    await page.getByRole("menuitem", { name: "添加 Agent 步骤" }).click();
    await page.locator(".workflow-back").click();
    await expect(page.locator(".workflow-library-card").filter({ hasText: "自定义工作流" })).toHaveCount(0);
  });

  test("persists custom node positions after dragging at a fractional zoom", async ({ page }) => {
    await page.locator(".primary-nav").getByRole("button", { name: "工作流", exact: true }).click();
    await page.getByRole("button", { name: "新建工作流" }).click();
    await page.getByRole("button", { name: "添加工作流步骤" }).click();
    await page.getByRole("menuitem", { name: "添加 Agent 步骤" }).click();
    await page.getByRole("button", { name: "缩小", exact: true }).click();
    const node = page.locator(".workflow-editor-node.custom-node");
    const bounds = await node.boundingBox();
    if (!bounds) throw new Error("custom node is not measurable");
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + bounds.height / 2 + 40);
    await page.mouse.up();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
    const saved = await page.evaluate(() => window.afkDesktop.snapshot(""));
    expect(saved.workflow.canvasNodes).toHaveLength(1);
    expect(Number.isInteger(saved.workflow.canvasNodes[0].x)).toBe(true);
    expect(Number.isInteger(saved.workflow.canvasNodes[0].y)).toBe(true);
    expect(saved.workflow.canvasNodes[0].x).toBeGreaterThan(292);
  });

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

  test("keeps a sequential workflow aligned without overlapping its track bands", async ({ page }) => {
    await page.getByRole("button", { name: "工作流" }).click();
    await page.locator(".workflow-library-card").first().click();

    // Measure the stage itself: toBeVisible() only inspects the element's own box
    // and is blind to an ancestor clipping it (the canvas rendered 0px high for a
    // whole phase while every node test stayed green).
    const stage = page.locator(".workflow-editor-stage");
    await expectOccupiesSpace(page, ".workflow-editor-stage", 200);

    await expect(page.locator(".workflow-canvas-track")).toHaveCount(2);
    expect(await page.locator(".workflow-editor-node:not(.origin-node)").evaluateAll(nodes => new Set(nodes.map(node => Math.round(node.getBoundingClientRect().top))).size)).toBe(1);
    expect(await page.locator(".workflow-canvas-track").evaluateAll(bands => bands.every((band, index) => bands.slice(index + 1).every(other => {
      const left = band.getBoundingClientRect();
      const right = other.getBoundingClientRect();
      return left.right <= right.left || right.right <= left.left || left.bottom <= right.top || right.bottom <= left.top;
    })))).toBe(true);
  });

  test("keeps the zoom controls clickable beside the inspector", async ({ page }) => {
    await page.getByRole("button", { name: "工作流" }).click();
    await page.locator(".workflow-library-card").first().click();
    await page.waitForTimeout(400);

    const hit = await page.evaluate(() => {
      const zoom = document.querySelector(".workflow-canvas-zoom button");
      if (!zoom) return "missing";
      const box = zoom.getBoundingClientRect();
      const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return Boolean(top && (top === zoom || zoom.contains(top))) ? "reachable" : (top?.className?.toString() ?? "none");
    });

    expect(hit, "the zoom button is covered by the inspector").toBe("reachable");
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
    const zoomLabel = page.locator(".workflow-canvas-zoom-label");
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

    const studio = page.locator(".workflow-studio-page");
    const workspace = page.locator(".workspace");
    if (!(await studio.boundingBox()) || !(await workspace.boundingBox())) {
      throw new Error("workflow studio layout is not measurable");
    }
    // The view entry animation travels 4px, which is wider than this 2px
    // tolerance, so a single snapshot measures the page mid-flight. Poll until
    // it settles instead of reading the first frame.
    await expect
      .poll(async () => {
        const [p, w] = await Promise.all([studio.boundingBox(), workspace.boundingBox()]);
        return Math.abs(p!.y + p!.height - (w!.y + w!.height));
      })
      .toBeLessThanOrEqual(2);
  });

  test("gives the canvas a stage tall enough to show its nodes", async ({ page }) => {
    await page.locator(".primary-nav").getByRole("button", { name: "工作流", exact: true }).click();
    await page.locator(".workflow-library-card").first().click();

    // Playwright's toBeVisible() only looks at the element's own box, so it is
    // blind to an ancestor clipping it away — which is how a zero-height stage
    // passed eleven green tests while the canvas showed nothing at all.
    const stage = await page.locator(".workflow-editor-stage").boundingBox();
    expect(stage?.height, "the stage collapsed and clipped every node").toBeGreaterThan(200);
    const painted = await page.evaluate(() => {
      const node = document.querySelector(".workflow-editor-node");
      if (!node) return false;
      const box = node.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return Boolean(hit && (hit === node || node.contains(hit)));
    });
    expect(painted, "a node is not the topmost thing at its own centre").toBe(true);
  });

  test("uses the available editor width instead of collapsing the canvas", async ({ page }) => {
    await page.getByRole("button", { name: "工作流" }).click();
    await page.locator(".workflow-library-card").first().click();

    // Read one layout snapshot: a scrollbar can disappear between separate
    // boundingBox calls while the editor replaces the workflow library.
    await expect(async () => {
      const widths = await page.evaluate(() => ({
        page: document.querySelector(".workflow-studio-page")?.getBoundingClientRect().width,
        canvas: document.querySelector(".workflow-studio-canvas")?.getBoundingClientRect().width,
        inspector: document.querySelector(".workflow-studio-inspector")?.getBoundingClientRect().width,
      }));
      expect(widths.inspector).toBeGreaterThanOrEqual(280);
      expect(widths.inspector).toBeLessThanOrEqual(336);
      expect(widths.canvas! + widths.inspector!).toBeCloseTo(widths.page!, 0);
    }).toPass({ timeout: 10_000 });
  });

  test("uses one icon-only add trigger with clearly labeled step choices", async ({ page }) => {
    await page.getByRole("button", { name: "工作流" }).click();
    await page.locator(".workflow-library-card").first().click();

    const toolbar = page.locator(".workflow-studio-toolbar");
    const trigger = toolbar.getByRole("button", { name: "添加工作流步骤" });
    await expect(trigger).toHaveText("");
    await expect(trigger.locator("svg")).toHaveCount(1);
    await expect(toolbar.getByRole("button")).toHaveCount(2);

    await trigger.click();
    const menu = page.getByRole("menu", { name: "添加工作流步骤" });
    await expect(menu.getByRole("menuitem", { name: "添加 Agent 步骤" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "添加审查 Agent" })).toBeVisible();
  });

  test("keeps workflow inspector select menus opaque above the following fields", async ({ page }) => {
    // 石墨 was removed when the themes collapsed to 浅色 / 深色; asking for it
    // here could only ever time out.
    for (const theme of ["浅色", "深色"]) {
      await navButton(page, "设置").click();
      await page.getByRole("radiogroup", { name: "界面主题" }).getByRole("radio", { name: theme }).click();
      await page.locator(".primary-nav").getByRole("button", { name: "工作流", exact: true }).click();
      await page.locator(".workflow-library-card").first().click();
      await page.locator(".workflow-editor-node").filter({ hasText: "开始" }).click();

      const trigger = page.getByRole("button", { name: "默认 Agent" });
      await trigger.click();

      const menu = page.getByRole("listbox", { name: "默认 Agent" });
      const popover = trigger.locator("..").locator(".select-menu-popover");
      await expect(menu).toBeVisible();
      const triggerBounds = await trigger.boundingBox();
      const popoverBounds = await popover.boundingBox();
      expect(triggerBounds).not.toBeNull();
      expect(popoverBounds).not.toBeNull();
      expect(Math.abs(popoverBounds!.width - triggerBounds!.width)).toBeLessThanOrEqual(1);
      const searchInput = popover.getByRole("combobox", { name: "搜索默认 Agent" });
      await expect(searchInput).toBeFocused();
      await expect(searchInput).toHaveCSS("border-top-width", "0px");
      await expect(searchInput).toHaveCSS("outline-width", "0px");
      await expect(searchInput).toHaveCSS("box-shadow", "none");
      const background = await popover.evaluate(element => getComputedStyle(element).backgroundColor);
      expect(background).toMatch(/^rgb\(/);
      await expect(popover).toHaveCSS("opacity", "1");
      await expect(menu).toHaveCSS("background-color", /^rgb\(/);
      for (const side of ["top", "right", "bottom", "left"]) {
        await expect(popover).toHaveCSS(`border-${side}-width`, "1px");
        await expect(popover).toHaveCSS(`border-${side}-style`, "solid");
      }
      await expect(menu.locator('[role="option"]')).toHaveCount(6);
      const overlap = await popover.evaluate(element => {
        const nextControl = element.closest(".workflow-field")!.nextElementSibling!.querySelector("input, button")!;
        const nextBounds = nextControl.getBoundingClientRect();
        const bounds = element.getBoundingClientRect();
        const left = Math.max(bounds.left, nextBounds.left);
        const right = Math.min(bounds.right, nextBounds.right);
        const top = Math.max(bounds.top, nextBounds.top);
        const bottom = Math.min(bounds.bottom, nextBounds.bottom);
        return {
          width: right - left,
          height: bottom - top,
          covered: element.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2)),
        };
      });
      expect(overlap.width).toBeGreaterThan(0);
      expect(overlap.height).toBeGreaterThan(0);
      expect(overlap.covered).toBe(true);
      if (process.env.AFK_UI_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.AFK_UI_EVIDENCE_DIR}/workflow-overlay-${theme}.png` });
    }
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
      await page.locator(".workflow-back").click();
      activeCard = page.locator(".workflow-library-card.active");
    }

    await expect(activeCard.locator(".workflow-library-card-status")).toHaveText("当前模板");
    await expect(activeCard.locator(".workflow-library-card-status")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  });

  test("uses compact studio controls and node kind labels in definition mode", async ({ page }) => {
    await page.getByRole("button", { name: "工作流" }).click();
    await page.locator(".workflow-library-card").first().click();

    const saveButton = page.getByRole("button", { name: "保存", exact: true }).first();
    const addButton = page.getByRole("button", { name: "添加工作流步骤" });
    const saveBox = await saveButton.boundingBox();
    const addBox = await addButton.boundingBox();
    if (!saveBox || !addBox) throw new Error("workflow controls are not measurable");
    expect(saveBox.height).toBeLessThanOrEqual(28);
    expect(addBox.width).toBeLessThanOrEqual(32.01);
    expect(addBox.height).toBeLessThanOrEqual(32.01);

    const nodeStatus = page.locator(".workflow-editor-node .workflow-node-status").first();
    await expect(nodeStatus).toBeVisible();
    await expect(nodeStatus).toHaveText("配置");
    await expect(nodeStatus).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  });
});
