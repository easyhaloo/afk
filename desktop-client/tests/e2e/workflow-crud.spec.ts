import { test, expect } from "./_helpers/launch";
import type { Page, TestInfo } from "@playwright/test";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { dump, load } from "js-yaml";
import type { WorkflowTemplateStepSummary } from "../../shared/ipc-contract";

const scenarios: Array<{ name: string; extension: string; steps: WorkflowTemplateStepSummary[] }> = [
  { name: "single", extension: "yml", steps: [
    { id: "implement", kind: "agent", role: "implementer", dependsOn: [] },
  ] },
  { name: "linear", extension: "yaml", steps: [
    { id: "implement", kind: "agent", role: "implementer", dependsOn: [] },
    { id: "review", kind: "agent", role: "reviewer", dependsOn: ["implement"] },
    { id: "publish", kind: "system", role: "system", action: "publish-changes", dependsOn: ["review"] },
  ] },
  { name: "diamond", extension: "yml", steps: [
    { id: "implement", kind: "agent", role: "implementer", dependsOn: [] },
    { id: "verify", kind: "agent", role: "verifier", dependsOn: ["implement"] },
    { id: "review", kind: "agent", role: "reviewer", dependsOn: ["implement"] },
    { id: "publish", kind: "system", role: "system", action: "publish-changes", dependsOn: ["verify", "review"] },
  ] },
  { name: "multiple-roots", extension: "yaml", steps: [
    { id: "frontend", kind: "agent", role: "implementer", dependsOn: [] },
    { id: "backend", kind: "agent", role: "implementer", dependsOn: [] },
    { id: "integrate", kind: "agent", role: "verifier", dependsOn: ["frontend", "backend"] },
  ] },
  { name: "conditional", extension: "yml", steps: [
    { id: "review", kind: "agent", role: "reviewer", dependsOn: [] },
    { id: "publish", kind: "system", role: "system", action: "publish-changes", dependsOn: ["review"], when: { step: "review", equals: "PASS" } },
    { id: "repair", kind: "agent", role: "implementer", dependsOn: ["review"], when: { step: "review", equals: "FAIL" } },
  ] },
  { name: "long-chain", extension: "yaml", steps: Array.from({ length: 12 }, (_, index) => ({
    id: `step-${index + 1}`, kind: "agent", role: "implementer", dependsOn: index ? [`step-${index}`] : [],
  })) },
  { name: "wide-fan-in", extension: "yml", steps: [
    { id: "prepare", kind: "agent", role: "implementer", dependsOn: [] },
    ...Array.from({ length: 5 }, (_, index): WorkflowTemplateStepSummary => ({
      id: `review-${index + 1}`, kind: "agent", role: "reviewer", dependsOn: ["prepare"],
    })),
    { id: "publish", kind: "system", role: "system", action: "publish-changes", dependsOn: Array.from({ length: 5 }, (_, index) => `review-${index + 1}`) },
  ] },
];

async function openLibrary(page: Page) {
  await page.locator(".primary-nav").getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("radiogroup", { name: "界面主题" }).getByRole("radio", { name: "浅色" }).click();
  await page.locator(".primary-nav").getByRole("button", { name: "工作流", exact: true }).click();
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const filename = `${name}.png`;
  const screenshotPath = process.env.AFK_UI_EVIDENCE_DIR
    ? path.join(process.env.AFK_UI_EVIDENCE_DIR, filename) : testInfo.outputPath(filename);
  await mkdir(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach(name, { path: screenshotPath, contentType: "image/png" });
}

async function expectGraphFits(page: Page) {
  await expect.poll(() => page.locator(".workflow-editor-stage").evaluate(stage => {
    const bounds = stage.getBoundingClientRect();
    const boxes = [...stage.querySelectorAll(".workflow-editor-node")].map(node => ({ label: node.querySelector("b")?.textContent, box: node.getBoundingClientRect() }));
    const problems = bounds.height > 200 ? [] : ["stage collapsed"];
    if (stage.scrollLeft || stage.scrollTop) problems.push(`unexpected stage scroll ${stage.scrollLeft},${stage.scrollTop}`);
    boxes.forEach(({ label, box }, index) => {
      if (box.width <= 0 || box.height <= 0 || box.left < bounds.left - 1 || box.right > bounds.right + 1 || box.top < bounds.top - 1 || box.bottom > bounds.bottom + 1) problems.push(`${label} clipped`);
      boxes.slice(index + 1).forEach(other => {
        if (box.right > other.box.left && other.box.right > box.left && box.bottom > other.box.top && other.box.bottom > box.top) problems.push(`${label} overlaps ${other.label}`);
      });
    });
    stage.querySelectorAll(".workflow-edge-label").forEach(label => {
      const box = label.getBoundingClientRect();
      if (boxes.some(node => box.right > node.box.left && node.box.right > box.left && box.bottom > node.box.top && node.box.bottom > box.top)) problems.push(`${label.textContent} obscured by a node`);
    });
    return problems;
  })).toEqual([]);
  const canvas = await page.locator(".workflow-studio-canvas").boundingBox();
  const inspector = await page.locator(".workflow-studio-inspector").boundingBox();
  expect(canvas!.x + canvas!.width).toBeLessThanOrEqual(inspector!.x + 1);
}

test.describe("Workflow CRUD and graph evidence", () => {
  test("creates, reads, updates and deletes managed steps through the UI and persists rewired dependencies", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1680, height: 1000 });
    await openLibrary(page);
    await page.getByRole("button", { name: "新建工作流" }).click();
    for (const [name, label] of [["添加 Agent 步骤", "实现功能"], ["添加审查 Agent", "质量审查"], ["添加 Agent 步骤", "交付结果"]]) {
      await page.getByRole("button", { name: "添加工作流步骤" }).click();
      await page.getByRole("menuitem", { name, exact: true }).click();
      await page.getByLabel("节点名称", { exact: true }).fill(label);
    }
    const save = page.getByRole("button", { name: "保存", exact: true });
    await save.click();
    await expect(save).toBeDisabled();
    await expect(page.locator(".workflow-editor-node.custom-node")).toHaveCount(3);
    const created = await page.evaluate(() => window.afkDesktop.snapshot(""));
    const templatePath = path.join(created.workspace.root, ".afk/workflows/afk-control-workflow.yml");
    const readDefinition = async () => load(await readFile(templatePath, "utf8")) as { steps: WorkflowTemplateStepSummary[] };
    expect((await readDefinition()).steps.map(step => step.role)).toEqual(["implementer", "reviewer", "implementer"]);
    await expectGraphFits(page);
    await capture(page, testInfo, "crud-01-created");

    await page.reload();
    await openLibrary(page);
    await page.locator(".workflow-library-card").filter({ hasText: "自定义工作流" }).click();
    await expect(page.locator(".workflow-editor-node.custom-node .workflow-editor-node-copy > b")).toHaveText(["实现功能", "质量审查", "交付结果"]);
    await page.locator(".workflow-editor-node.custom-node").filter({ hasText: "质量审查" }).click();
    await expect(page.getByLabel("节点名称", { exact: true })).toHaveValue("质量审查");
    await capture(page, testInfo, "crud-02-reloaded");
    await page.getByLabel("节点名称", { exact: true }).fill("验收审查");
    await page.getByRole("textbox", { name: "节点说明", exact: true }).fill("验证测试结果及验收条件");
    await page.getByRole("textbox", { name: "执行指令", exact: true }).fill("Run the acceptance checks and report PASS or FAIL.");
    await page.getByRole("button", { name: "执行 Agent", exact: true }).click();
    await page.getByRole("option", { name: "codex", exact: true }).click();
    await save.click();
    await expect(save).toBeDisabled();
    await page.reload();
    await openLibrary(page);
    await page.locator(".workflow-library-card").filter({ hasText: "自定义工作流" }).click();
    await page.locator(".workflow-editor-node.custom-node").filter({ hasText: "验收审查" }).click();
    await expect(page.getByRole("textbox", { name: "节点说明", exact: true })).toHaveValue("验证测试结果及验收条件");
    await expect(page.getByRole("textbox", { name: "执行指令", exact: true })).toHaveValue("Run the acceptance checks and report PASS or FAIL.");
    await expect(page.getByRole("button", { name: "执行 Agent", exact: true })).toContainText("codex");
    expect((await readDefinition()).steps[1]).toMatchObject({ provider: "codex", role: "reviewer", prompt: "Run the acceptance checks and report PASS or FAIL." });
    await capture(page, testInfo, "crud-03-updated");

    const removedId = created.workflow.canvasNodes[1].id;
    await page.getByRole("button", { name: "移除节点", exact: true }).click();
    await save.click();
    await expect(save).toBeDisabled();
    await page.reload();
    await openLibrary(page);
    await page.locator(".workflow-library-card").filter({ hasText: "自定义工作流" }).click();
    await expect(page.locator(".workflow-editor-node.custom-node .workflow-editor-node-copy > b")).toHaveText(["实现功能", "交付结果"]);
    const remaining = (await readDefinition()).steps;
    expect(remaining.map(step => step.id)).toEqual([created.workflow.canvasNodes[0].id, created.workflow.canvasNodes[2].id]);
    expect(remaining[1].dependsOn).toEqual([remaining[0].id]);
    expect(remaining.some(step => step.dependsOn?.includes(removedId))).toBe(false);
    await expect(page.locator(".workflow-edge")).toHaveCount(2);
    await expectGraphFits(page);
    await capture(page, testInfo, "crud-04-deleted-and-rewired");
  });

  test("discovers, refreshes and removes project YAML definitions without changing built-in templates", async ({ page }, testInfo) => {
    const snapshot = await page.evaluate(() => window.afkDesktop.snapshot(""));
    const directory = path.join(snapshot.workspace.root, ".afk/workflows");
    await mkdir(directory, { recursive: true });
    const filename = path.join(directory, "project-crud.yaml");
    await writeFile(filename, dump({ name: "project-crud", version: 1, steps: scenarios[0].steps }));
    await page.reload();
    await openLibrary(page);
    const cards = page.locator(".workflow-library-card");
    await expect(cards.filter({ hasText: "project-crud" })).toBeVisible();
    const initialCount = await cards.count();
    await cards.filter({ hasText: "project-crud" }).click();
    await expect(page.locator(".workflow-editor-node")).toHaveCount(2);
    await capture(page, testInfo, "project-crud-01-created");
    await writeFile(filename, dump({ name: "project-crud", version: 1, steps: scenarios[2].steps }));
    await page.reload();
    await openLibrary(page);
    await cards.filter({ hasText: "project-crud" }).click();
    await expect(page.locator(".workflow-editor-node")).toHaveCount(5);
    await expect(page.locator(".workflow-edge")).toHaveCount(5);
    await capture(page, testInfo, "project-crud-02-updated");
    await unlink(filename);
    await page.reload();
    await openLibrary(page);
    await expect(cards.filter({ hasText: "project-crud" })).toHaveCount(0);
    await expect(cards).toHaveCount(initialCount - 1);
    await expect(cards.filter({ hasText: "Issue 实现" })).toBeVisible();
    await capture(page, testInfo, "project-crud-03-deleted");
  });

  test("validates, saves and restores workflow configuration while preserving unrelated YAML", async ({ page }, testInfo) => {
    const snapshot = await page.evaluate(() => window.afkDesktop.snapshot(""));
    const configPath = path.join(snapshot.workspace.root, ".afk/config.yml");
    await writeFile(configPath, dump({ customIntegration: { enabled: true, label: "preserve-me" } }));
    await page.reload();
    await openLibrary(page);
    await page.locator(".workflow-library-card").first().click();
    await page.locator(".workflow-editor-node.origin-node").click();
    const save = page.getByRole("button", { name: "保存", exact: true });
    const originalConfig = await readFile(configPath, "utf8");
    await page.getByLabel("目标分支", { exact: true }).fill("invalid..branch");
    await save.click();
    await expect(page.getByRole("alert")).toContainText("目标分支不是有效 Git 分支名");
    expect(await readFile(configPath, "utf8")).toBe(originalConfig);
    await capture(page, testInfo, "config-01-validation");
    await page.getByLabel("目标分支", { exact: true }).fill("feature/workflow-e2e");
    await page.getByLabel("基准分支", { exact: true }).fill("develop");
    await page.getByLabel("tmux 会话", { exact: true }).fill("afk-workflow-e2e");
    await page.getByLabel("最大重试", { exact: true }).fill("4");
    await page.getByLabel("工作流超时（分钟）", { exact: true }).fill("12.5");
    await save.click();
    await expect(save).toBeDisabled();
    expect(load(await readFile(configPath, "utf8"))).toMatchObject({ customIntegration: { enabled: true, label: "preserve-me" }, workflowHardTimeout: 750000, maxRetries: 4 });
    await page.reload();
    await openLibrary(page);
    await page.locator(".workflow-library-card.active").click();
    await page.locator(".workflow-editor-node.origin-node").click();
    for (const [label, value] of [["目标分支", "feature/workflow-e2e"], ["基准分支", "develop"], ["tmux 会话", "afk-workflow-e2e"], ["最大重试", "4"], ["工作流超时（分钟）", "12.5"]]) {
      await expect(page.getByLabel(label, { exact: true })).toHaveValue(value);
    }
    await capture(page, testInfo, "config-02-persisted");
    await page.getByLabel("最大重试", { exact: true }).fill("8");
    await page.getByRole("button", { name: "还原", exact: true }).click();
    await expect(page.getByLabel("最大重试", { exact: true })).toHaveValue("4");
    await expect(save).toBeDisabled();
  });

  test("saves twelve managed nodes and keeps their layout after reopening", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1680, height: 1000 });
    await openLibrary(page);
    await page.getByRole("button", { name: "新建工作流" }).click();
    for (let index = 0; index < 12; index += 1) {
      await page.getByRole("button", { name: "添加工作流步骤" }).click();
      await page.getByRole("menuitem", { name: index % 3 === 2 ? "添加审查 Agent" : "添加 Agent 步骤", exact: true }).click();
      await page.getByLabel("节点名称", { exact: true }).fill(`步骤 ${index + 1}`);
    }
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
    const saved = await page.evaluate(() => window.afkDesktop.snapshot(""));
    expect(saved.workflow.canvasNodes).toHaveLength(12);
    expect(saved.workflow.canvasNodes.every(node => node.x <= 1400 && node.y <= 440)).toBe(true);
    await page.reload();
    await openLibrary(page);
    await page.locator(".workflow-library-card").filter({ hasText: "自定义工作流" }).click();
    await expect(page.locator(".workflow-editor-node.custom-node")).toHaveCount(12);
    await expect(page.locator(".workflow-edge")).toHaveCount(12);
    const reopened = await page.evaluate(() => window.afkDesktop.snapshot(""));
    expect(reopened.workflow.canvasNodes).toEqual(saved.workflow.canvasNodes);
    await expectGraphFits(page);
    await capture(page, testInfo, "managed-twelve-nodes");
  });

  for (const scenario of scenarios) {
    test(`renders ${scenario.name} from .${scenario.extension} with correct dependencies and responsive geometry`, async ({ page }, testInfo) => {
      const snapshot = await page.evaluate(() => window.afkDesktop.snapshot(""));
      const directory = path.join(snapshot.workspace.root, ".afk/workflows");
      await mkdir(directory, { recursive: true });
      const document = dump({ name: `e2e-${scenario.name}`, version: 1, steps: scenario.steps });
      await writeFile(path.join(directory, `${scenario.name}.${scenario.extension}`), document);
      await testInfo.attach(`${scenario.name}.${scenario.extension}`, { body: document, contentType: "application/yaml" });
      if (process.env.AFK_UI_EVIDENCE_DIR) {
        await mkdir(process.env.AFK_UI_EVIDENCE_DIR, { recursive: true });
        await writeFile(path.join(process.env.AFK_UI_EVIDENCE_DIR, `${scenario.name}.${scenario.extension}`), document);
      }
      await page.reload();
      await openLibrary(page);
      await page.locator(".workflow-library-card").filter({ hasText: `e2e-${scenario.name}` }).click();
      await expect(page.locator(".workflow-editor-node")).toHaveCount(scenario.steps.length + 1);
      await expect(page.locator(".workflow-edge")).toHaveCount(scenario.steps.reduce((count, step) => count + Math.max(1, step.dependsOn.length), 0));
      await expect(page.locator(".workflow-graph-warning")).toHaveCount(0);
      for (const step of scenario.steps) {
        await page.locator(".workflow-editor-node").filter({ has: page.getByText(step.id, { exact: true }) }).click();
        const dependencies = page.getByRole("region", { name: "前置依赖", exact: true });
        await expect(dependencies.locator(".workflow-dependency-chip")).toHaveText(step.dependsOn);
        if (!step.dependsOn.length) await expect(dependencies).toContainText("无前置步骤");
        if (step.when) await expect(page.locator(".workflow-studio-inspector")).toContainText(`${step.when.step} = ${step.when.equals}`);
        await expect(page.getByRole("button", { name: "移除节点", exact: true })).toHaveCount(0);
      }
      const conditions = scenario.steps.filter(step => step.when).flatMap(step => step.dependsOn.map(() => `${step.when!.step} = ${step.when!.equals}`));
      await expect(page.locator(".workflow-edge.conditional text")).toHaveText(conditions);
      for (const width of [1680, 1024]) {
        await page.setViewportSize({ width, height: 1000 });
        await expectGraphFits(page);
        await expect.poll(() => page.getByRole("region", { name: "前置依赖", exact: true }).evaluate(section => {
          const bounds = section.getBoundingClientRect();
          const rule = section.querySelector("p")!.getBoundingClientRect();
          return [...section.querySelectorAll(".workflow-dependency-chip")].every(chip => {
            const box = chip.getBoundingClientRect();
            return box.left >= bounds.left && box.right <= bounds.right && box.bottom <= rule.top;
          });
        })).toBe(true);
        await capture(page, testInfo, `graph-${scenario.name}-${width}`);
      }
      if (scenario.name === "conditional") {
        await page.locator(".primary-nav").getByRole("button", { name: "设置", exact: true }).click();
        await page.getByRole("radiogroup", { name: "界面主题" }).getByRole("radio", { name: "深色" }).click();
        await page.locator(".primary-nav").getByRole("button", { name: "工作流", exact: true }).click();
        if (await page.locator(".workflow-library-card").count()) await page.locator(".workflow-library-card").filter({ hasText: "e2e-conditional" }).click();
        await expectGraphFits(page);
        await capture(page, testInfo, "graph-conditional-dark-1024");
      }
    });
  }
});
