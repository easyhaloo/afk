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

export async function collectProviderInventory(platform) {
  if (process.env.FAKE_AFK_FAIL_INVENTORY === "1") throw new Error("FAKE_AFK_FAIL_INVENTORY is set");
  if (process.env.FAKE_AFK_INVENTORY_CALLS) appendFileSync(process.env.FAKE_AFK_INVENTORY_CALLS, `${Date.now()}\n`, "utf8");
  const delayMs = Number(process.env.FAKE_AFK_INVENTORY_DELAY_MS ?? "0");
  if (Number.isFinite(delayMs) && delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
  const inventory = structuredClone(INVENTORY);
  if (process.env.FAKE_AFK_STORE && existsSync(process.env.FAKE_AFK_STORE)) {
    const store = JSON.parse(readFileSync(process.env.FAKE_AFK_STORE, "utf8"));
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

// --- Backlog management and execution fixtures -----------------------------
//
// The desktop calls the backlog use cases and the work item execution in
// process, so the suite replaces the runtime bundle with this fixture: the
// provider factory and the execution runtime come from here, not from a
// real provider or a real agent.

const BACKLOG_SEED = {
  items: [
    { id: "1", workItemId: "github:acme/api#1", issueNumber: 1, project: { platform: "github", projectKey: "acme/api", name: "api", defaultBranch: "main", webUrl: "https://github.com/acme/api" }, managed: true, executionEligible: true, title: "登录态切换", description: "切换登录态并保留当前工作区。", dependsOn: [], state: "ready", executionMode: "afk", tags: ["billing"], branchName: "afk/backlog-1", providerRef: "github:acme/api#1", webUrl: "https://github.com/example/issues/1" },
    { id: "2", workItemId: "github:acme/api#2", issueNumber: 2, project: { platform: "github", projectKey: "acme/api", name: "api", defaultBranch: "main", webUrl: "https://github.com/acme/api" }, managed: false, executionEligible: false, title: "kg 演示", dependsOn: ["1"], state: "in_progress", executionMode: "afk", tags: ["urgent"], branchName: "afk/backlog-2", providerRef: "stub:2" },
    { id: "3", workItemId: "github:acme/api#3", issueNumber: 3, project: { platform: "github", projectKey: "acme/api", name: "api", defaultBranch: "main", webUrl: "https://github.com/acme/api" }, managed: false, executionEligible: false, title: "支付回调", dependsOn: [], state: "done", executionMode: "hitl", tags: [], branchName: "afk/backlog-3", providerRef: "stub:3" },
  ],
  nextId: 5,
  changes: {},
};

function loadBacklogStore() {
  const storePath = process.env.FAKE_AFK_STORE;
  if (!storePath || !existsSync(storePath)) return structuredClone(BACKLOG_SEED);
  try {
    const parsed = JSON.parse(readFileSync(storePath, "utf8"));
    if (!Array.isArray(parsed.items) || typeof parsed.nextId !== "number") throw new Error("malformed store");
    parsed.changes ??= {};
    return parsed;
  } catch {
    return structuredClone(BACKLOG_SEED);
  }
}

function saveBacklogStore(store) {
  const storePath = process.env.FAKE_AFK_STORE;
  if (!storePath) return;
  try {
    writeFileSync(`${storePath}.${process.pid}.tmp`, JSON.stringify(store), "utf8");
    renameSync(`${storePath}.${process.pid}.tmp`, storePath);
  } catch {
    // best-effort
  }
}

function findItem(store, id) {
  return store.items.find((item) => item.id === id || item.workItemId === id);
}

export function createManagementProviders() {
  const backlog = {
    async get(id) {
      const item = findItem(loadBacklogStore(), id);
      if (!item) throw new Error(`backlog item not found: ${id}`);
      return structuredClone(item);
    },
    async list(options = {}) {
      let items = loadBacklogStore().items.slice();
      if (options.state) items = items.filter((item) => item.state === options.state);
      if (options.executionMode) items = items.filter((item) => item.executionMode === options.executionMode);
      if (options.parentId) items = items.filter((item) => item.parentId === options.parentId);
      if (options.tag) items = items.filter((item) => item.tags.includes(options.tag));
      return structuredClone(items);
    },
    async create(input) {
      const store = loadBacklogStore();
      const id = String(store.nextId);
      const issueNumber = Number(id);
      const item = {
        id,
        workItemId: `github:acme/api#${issueNumber}`,
        issueNumber,
        project: { platform: "github", projectKey: "acme/api", name: "api", defaultBranch: "main", webUrl: "https://github.com/acme/api" },
        managed: true,
        executionEligible: true,
        title: input.title,
        description: input.description,
        dependsOn: input.dependsOn ?? [],
        state: "ready",
        executionMode: input.executionMode ?? "afk",
        tags: input.tags ?? [],
        branchName: `afk/backlog-${id}`,
        providerRef: `github:acme/api#${issueNumber}`,
        webUrl: `https://github.com/acme/api/issues/${issueNumber}`,
        parentId: input.parentId,
        baseBacklogId: input.baseBacklogId,
      };
      store.items.unshift(item);
      store.nextId += 1;
      saveBacklogStore(store);
      return structuredClone(item);
    },
    async addTag(id, tag) {
      const store = loadBacklogStore();
      const item = findItem(store, id);
      if (!item) throw new Error(`backlog item not found: ${id}`);
      if (!item.tags.includes(tag)) item.tags.push(tag);
      saveBacklogStore(store);
    },
    async removeTag(id, tag) {
      const store = loadBacklogStore();
      const item = findItem(store, id);
      if (!item) throw new Error(`backlog item not found: ${id}`);
      item.tags = item.tags.filter((existing) => existing !== tag);
      saveBacklogStore(store);
    },
    async initialize() {},
    async transition(id, state) {
      const store = loadBacklogStore();
      const item = findItem(store, id);
      if (!item) throw new Error(`backlog item not found: ${id}`);
      item.state = state;
      if (state === "blocked") item.executionMode = "hitl";
      saveBacklogStore(store);
    },
    async setExecutionMode(id, mode) {
      const store = loadBacklogStore();
      const item = findItem(store, id);
      if (!item) throw new Error(`backlog item not found: ${id}`);
      item.executionMode = mode;
      saveBacklogStore(store);
    },
    async createRework(id, record) {
      const store = loadBacklogStore();
      const item = findItem(store, id);
      if (!item) throw new Error(`backlog item not found: ${id}`);
      item.state = "rework";
      item.executionMode = "afk";
      saveBacklogStore(store);
      return { id: "r1", attempt: 1, status: "open", source: record.source, summary: record.summary, failedCriteria: [], requiredChecks: [], createdAt: new Date().toISOString() };
    },
    async getActiveRework() { return undefined; },
    async resolveRework() {},
  };

  const changes = {
    async findForBacklog(item) {
      const change = loadBacklogStore().changes?.[item.id];
      return change ? structuredClone(change) : null;
    },
    async merge(id) {
      const store = loadBacklogStore();
      for (const change of Object.values(store.changes ?? {})) {
        if (change.id === id) change.state = "merged";
      }
      saveBacklogStore(store);
    },
    async get(id) {
      const store = loadBacklogStore();
      const change = Object.values(store.changes ?? {}).find((candidate) => candidate.id === id);
      if (!change) throw new Error(`change request not found: ${id}`);
      return structuredClone(change);
    },
  };

  return Promise.resolve({ backlog, branches: {}, changes });
}

/**
 * The execution runtime the desktop drives. It moves the work item to
 * `merge_ready` and opens a change request, which is the state the desktop
 * offers to merge.
 */
export function executeWorkItem(input) {
  const store = loadBacklogStore();
  const item = findItem(store, input.workItemId);
  if (!item) throw new Error(`unknown work item: ${input.workItemId}`);
  item.state = "merge_ready";
  item.executionMode = "hitl";
  store.changes ??= {};
  store.changes[item.id] = {
    id: `change-${item.id}`,
    state: "open",
    sourceBranch: `${item.branchName}-qa`,
    targetBranch: "main",
    mergeable: true,
  };
  saveBacklogStore(store);
  return Promise.resolve({
    executionId: input.executionId ?? `e2e-${item.id}`,
    workItemId: input.workItemId,
    status: "merge_ready",
    changeUrl: `https://github.com/acme/api/pull/${item.issueNumber}`,
  });
}
