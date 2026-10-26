import { workspaceStateDirectory } from "@afk/runtime/infrastructure/workspace";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { load } from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveWorkflowConfig, snapshot } from "../../electron/services/desktop-service.js";

vi.mock("../../electron/adapters/process-executor.js", () => ({ executable: async () => undefined, firstLine: () => "" }));
vi.mock("../../electron/adapters/resource-adapter.js", () => ({ listAfkContainers: async () => [], listAfkTmux: async () => [] }));
vi.mock("../../electron/services/runtime-service.js", () => ({ detectAgentRuntimes: async () => [] }));
vi.mock("../../electron/services/project-run-scope-service.js", () => ({ projectRunScopeService: { workspaces: async (root: string) => [root], runs: async () => [] } }));

let directory: string;
const node = { id: "implement", template: "agent" as const, label: "实现", description: "实现工作项", prompt: "Implement the work item.", provider: "codex", x: 220, y: 74 };

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "afk-workflow-config-"));
  vi.stubEnv("HOME", directory);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function saveNode() {
  const current = await snapshot(directory);
  return saveWorkflowConfig(directory, { ...current.workflow, templateName: "afk-control-workflow", canvasNodes: [node] });
}

describe("workflow definition persistence", () => {
  it("rejects clearing the final managed node and keeps the saved definition intact", async () => {
    const saved = await saveNode();
    const templatePath = path.join(workspaceStateDirectory(), "workflows", "afk-control-workflow.yml");
    const configBefore = await readFile(saved.configPath, "utf8");
    const templateBefore = await readFile(templatePath, "utf8");

    await expect(saveWorkflowConfig(directory, { ...saved, canvasNodes: [] })).rejects.toThrow("自定义工作流至少需要一个步骤");

    expect(await readFile(saved.configPath, "utf8")).toBe(configBefore);
    expect(await readFile(templatePath, "utf8")).toBe(templateBefore);
    const reopened = await snapshot(directory);
    expect(reopened.workflow.canvasNodes).toEqual([node]);
    expect(reopened.workflowTemplates.find(template => template.id === saved.templateName)?.steps.map(step => step.id)).toEqual([node.id]);
  });

  it("rejects a new empty managed workflow before writing any files", async () => {
    const current = await snapshot(directory);
    await expect(saveWorkflowConfig(directory, { ...current.workflow, templateName: "afk-control-workflow", canvasNodes: [] })).rejects.toThrow("自定义工作流至少需要一个步骤");
    await expect(readFile(path.join(workspaceStateDirectory(), "config.yml"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(workspaceStateDirectory(), "workflows", "afk-control-workflow.yml"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rediscovers the saved step order, roles, providers and dependencies after replacing nodes", async () => {
    const saved = await saveNode();
    const nodes = [
      { ...node, id: "review", template: "qa" as const, label: "审查", prompt: "Review the change.", provider: "claude-code" },
      { ...node, id: "fix", label: "修复", prompt: "Fix the reported issues." },
    ];
    await saveWorkflowConfig(directory, { ...saved, canvasNodes: nodes });
    const reopened = await snapshot(directory);
    expect(reopened.workflow.canvasNodes).toEqual(nodes);
    expect(reopened.workflowTemplates.find(template => template.id === saved.templateName)?.steps).toMatchObject([
      { id: "review", role: "reviewer", provider: "claude-code", dependsOn: [] },
      { id: "fix", role: "implementer", provider: "codex", dependsOn: ["review"] },
    ]);
    expect(load(await readFile(path.join(workspaceStateDirectory(), "workflows", "afk-control-workflow.yml"), "utf8"))).toMatchObject({
      steps: [{ id: "review", prompt: nodes[0].prompt }, { id: "fix", prompt: nodes[1].prompt }],
    });
  });

  it("allows selecting a built-in template without custom nodes and preserves existing custom definitions", async () => {
    const saved = await saveNode();
    const templatePath = path.join(workspaceStateDirectory(), "workflows", "afk-control-workflow.yml");
    const templateBefore = await readFile(templatePath, "utf8");
    await saveWorkflowConfig(directory, { ...saved, templateName: "issue-implementation", canvasNodes: [] });
    const reopened = await snapshot(directory);
    expect(reopened.workflow).toMatchObject({ templateName: "issue-implementation", canvasNodes: [] });
    expect(reopened.workflowTemplates.find(template => template.id === "issue-implementation")?.steps).toHaveLength(4);
    expect(reopened.workflowTemplates.find(template => template.id === "afk-control-workflow")).toMatchObject({ canvasNodes: [node] });
    expect(await readFile(templatePath, "utf8")).toBe(templateBefore);
  });

  it("preserves unrelated project configuration when saving a definition", async () => {
    await mkdir(workspaceStateDirectory(), { recursive: true });
    await writeFile(path.join(workspaceStateDirectory(), "config.yml"), "tracker:\n  platform: github\n  projectKey: acme/api\n");
    const saved = await saveNode();
    expect(load(await readFile(saved.configPath, "utf8"))).toMatchObject({ tracker: { platform: "github", projectKey: "acme/api" } });
  });
});
