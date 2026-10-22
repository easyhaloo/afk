import { loadStore, mutateStore, INVENTORY } from "./provider-inventory.mjs";
import type { BacklogRuntime } from "@afk/runtime/backlog";
import type { ExecuteWorkItemInput, ExecuteWorkItemResult } from "@afk/runtime/execution";

function requireItem(store: ReturnType<typeof loadStore>, id: string) {
  const item = store.items.find((entry: { id: string }) => entry.id === id);
  if (!item) throw new Error(`backlog ${id} not found`);
  return item;
}

export function createBacklogRuntime(): BacklogRuntime {
  return {
    async list(_workspace, options = {}) {
      return loadStore().items.filter((item: { state: string; executionMode: string; parentId?: string; tags: string[] }) =>
        (!options.state || item.state === options.state)
        && (!options.executionMode || item.executionMode === options.executionMode)
        && (!options.parentId || item.parentId === options.parentId)
        && (!options.tag || item.tags.includes(options.tag)));
    },
    async show(_workspace, id) { return requireItem(loadStore(), id); },
    async create(_workspace, input) {
      return mutateStore(store => {
        const id = String(store.nextId++);
        const item = {
          ...input, id, issueNumber: Number(id), project: INVENTORY.projects[0],
          workItemId: `github:acme/api#${id}`, state: "ready", managed: true, executionEligible: true,
          dependsOn: input.dependsOn ?? [], tags: input.tags ?? [], executionMode: input.executionMode ?? "afk",
          branchName: `afk/backlog-${id}`, providerRef: `github:acme/api#${id}`, webUrl: `https://github.com/acme/api/issues/${id}`,
        };
        store.items.unshift(item);
        return item;
      });
    },
    async addTag(_workspace, id, tag) {
      return mutateStore(store => { const item = requireItem(store, id); if (!item.tags.includes(tag)) item.tags.push(tag); return item; });
    },
    async removeTag(_workspace, id, tag) {
      return mutateStore(store => { const item = requireItem(store, id); item.tags = item.tags.filter((value: string) => value !== tag); return item; });
    },
    async interrupt(_workspace, id) {
      return mutateStore(store => { const item = requireItem(store, id); item.state = "blocked"; item.executionMode = "hitl"; return item; });
    },
    async confirmMerge(_workspace, id) {
      return mutateStore(store => {
        const item = requireItem(store, id);
        if (item.parentId || item.state !== "merge_ready" || item.executionMode !== "hitl") throw new Error("merge confirmation requires root merge_ready + hitl");
        item.state = "done";
        store.history.push({ backlogId: id, state: "done" });
        return item;
      });
    },
  };
}

export async function executeWorkItem(input: ExecuteWorkItemInput): Promise<ExecuteWorkItemResult> {
  for (const state of ["in_progress", "verification", "merge_ready"]) {
    mutateStore(store => {
      const item = store.items.find((entry: { workItemId: string }) => entry.workItemId === input.workItemId);
      if (!item) throw new Error(`work item ${input.workItemId} not found`);
      item.state = state;
      item.executionMode = state === "merge_ready" ? "hitl" : "afk";
      store.history.push({ workItemId: input.workItemId, state });
    });
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { executionId: input.executionId!, workItemId: input.workItemId, status: "merge_ready" };
}
