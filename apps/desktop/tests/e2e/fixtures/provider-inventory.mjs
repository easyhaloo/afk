import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

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

export function loadStore() {
  const file = process.env.AFK_E2E_STORE;
  if (!file) throw new Error("AFK_E2E_STORE is required for runtime fixtures");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const project = INVENTORY.projects[0];
  const store = {
    items: [
      { ...INVENTORY.items[0], id: "1", workItemId: "github:acme/api#1", title: "登录态切换" },
      { ...INVENTORY.items[0], id: "2", workItemId: "github:acme/api#2", issueNumber: 2, title: "kg 演示", state: "in_progress", managed: false, executionEligible: false, dependsOn: ["1"], tags: ["urgent"], branchName: "afk/backlog-2", providerRef: "github:acme/api#2" },
      { ...INVENTORY.items[0], id: "3", workItemId: "github:acme/api#3", issueNumber: 3, project, title: "支付回调", state: "done", executionMode: "hitl", managed: false, executionEligible: false, tags: [], branchName: "afk/backlog-3", providerRef: "github:acme/api#3" },
    ], nextId: 5, history: [],
  };
  saveStore(store);
  return store;
}

function saveStore(store) {
  const file = process.env.AFK_E2E_STORE;
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(store), "utf8");
  renameSync(temporary, file);
}

export function mutateStore(transform) {
  const store = loadStore();
  const result = transform(store);
  saveStore(store);
  return result;
}

export async function collectProviderInventory(platform) {
  if (process.env.AFK_E2E_FAIL_INVENTORY === "1") throw new Error("AFK_E2E_FAIL_INVENTORY is set");
  if (process.env.AFK_E2E_INVENTORY_CALLS) appendFileSync(process.env.AFK_E2E_INVENTORY_CALLS, `${Date.now()}\n`, "utf8");
  const delayMs = Number(process.env.AFK_E2E_INVENTORY_DELAY_MS ?? "0");
  if (Number.isFinite(delayMs) && delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
  const inventory = structuredClone(INVENTORY);
  if (process.env.AFK_E2E_STORE && existsSync(process.env.AFK_E2E_STORE)) {
    const store = JSON.parse(readFileSync(process.env.AFK_E2E_STORE, "utf8"));
    for (const item of store.items ?? []) {
      const workItemId = item.workItemId ?? `github:${item.project?.projectKey}#${item.issueNumber}`;
      if (inventory.items.some(candidate => candidate.id === workItemId)) continue;
      inventory.items.push({
        id: workItemId,
        issueNumber: item.issueNumber,
        project: item.project,
        title: item.title,
        description: item.description,
        managed: item.managed,
        executionEligible: item.executionEligible,
        state: item.state,
        executionMode: item.executionMode,
        dependsOn: item.dependsOn ?? [],
        tags: item.tags ?? [],
        branchName: item.branchName,
        providerRef: item.providerRef,
        webUrl: item.webUrl,
      });
      if (!inventory.projects.some(candidate => candidate.platform === item.project.platform && candidate.projectKey === item.project.projectKey)) inventory.projects.push(item.project);
    }
  }
  inventory.items = inventory.items.filter(item => platform === "all" || item.project.platform === platform);
  inventory.projects = inventory.projects.filter(project => platform === "all" || project.platform === platform);
  return inventory;
}
