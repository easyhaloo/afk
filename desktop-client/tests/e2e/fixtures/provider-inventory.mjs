import { appendFileSync } from "node:fs";

export const INVENTORY = {
  items: [
    { id: "github:acme/api#1", issueNumber: 1, project: { platform: "github", projectKey: "acme/api", name: "api", defaultBranch: "main", webUrl: "https://github.com/acme/api" }, title: "API 登录态切换", description: "跨仓库 API 工作项。", managed: true, executionEligible: true, state: "ready", executionMode: "afk", dependsOn: [], tags: ["billing"], branchName: "afk/backlog-1", providerRef: "github:acme/api#1", webUrl: "https://github.com/acme/api/issues/1" },
    { id: "github:acme/web#1", issueNumber: 1, project: { platform: "github", projectKey: "acme/web", name: "web", defaultBranch: "main", webUrl: "https://github.com/acme/web" }, title: "Web 登录页调整", description: "同号但属于另一个仓库。", managed: false, executionEligible: false, state: "ready", executionMode: "hitl", dependsOn: [], tags: ["frontend"], branchName: "afk/backlog-1", providerRef: "github:acme/web#1", webUrl: "https://github.com/acme/web/issues/1" },
  ],
  projects: [
    { platform: "github", projectKey: "acme/api", name: "api", defaultBranch: "main", webUrl: "https://github.com/acme/api" },
    { platform: "github", projectKey: "acme/web", name: "web", defaultBranch: "main", webUrl: "https://github.com/acme/web" },
  ],
  diagnostics: [],
  complete: true,
};

export async function collectProviderInventory(platform) {
  if (process.env.FAKE_AFK_FAIL_INVENTORY === "1") throw new Error("FAKE_AFK_FAIL_INVENTORY is set");
  if (process.env.FAKE_AFK_INVENTORY_CALLS) appendFileSync(process.env.FAKE_AFK_INVENTORY_CALLS, `${Date.now()}\n`, "utf8");
  const delayMs = Number(process.env.FAKE_AFK_INVENTORY_DELAY_MS ?? "0");
  if (Number.isFinite(delayMs) && delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
  const inventory = structuredClone(INVENTORY);
  inventory.items = inventory.items.filter(item => platform === "all" || item.project.platform === platform);
  inventory.projects = inventory.projects.filter(project => platform === "all" || project.platform === platform);
  return inventory;
}
