import { createTaskRuntimePort } from "@afk/execution/application/runtime/task-runtime-port";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectRuntimeHealth } from "@afk/application";
import type { WorkItemRunRecord } from "../../shared/backlog-contract";
import { createExecutionRuntimeAdapter } from "../../electron/adapters/execution-runtime-adapter";

const roots: string[] = [];
const now = Date.parse("2026-10-15T01:00:00.000Z");
const workItemId = "github:owner/repo#1";
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "afk-health-")); roots.push(root);
  for (const bucket of ["active", "archive"]) await mkdir(path.join(root, bucket));
  const write = (bucket: string, value: unknown) => writeFile(path.join(root, bucket, `${Buffer.from("run-1").toString("base64url")}.json`), JSON.stringify(value));
  return { root, write };
}

/**
 * A record as the runtime writes it: the run, the work item it belongs to
 * and the moment it started. The environment a run ran in is optional
 * because history does not always know it.
 */
function record(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    backlogId: "42",
    phase: "implementing",
    status: "running",
    providerRef: workItemId,
    startedAt: "2026-10-15T00:00:00Z",
    heartbeatAt: "2026-10-15T00:00:00Z",
    ...overrides,
  };
}

describe("execution runtime observations", () => {
  it("reads exact identities and separates stale health from the audit outcome", async () => {
    const { root, write } = await setup();
    await write("active", record({ agentProvider: "codex", executionMode: "batch", agentTransport: "exec" }));
    const adapter = createExecutionRuntimeAdapter({ taskRuntime: createTaskRuntimePort({ root, now: () => now }), readReceipt: async () => undefined, now: () => now });
    expect(projectRuntimeHealth("run-1", await adapter.read("run-1", workItemId), now)).toMatchObject({ state: "stale", provider: "codex", executionMode: "batch" });
    expect(await adapter.read("run-1", "github:other/repo#1")).toBeUndefined();
    await write("active", record({ runId: "other-run", heartbeatAt: "2026-10-15T01:00:00Z" }));
    expect(await adapter.read("run-1", workItemId)).toBeUndefined();
  });
  it("keeps a root Runner live after an implementation archive and marks its actual exit", async () => {
    const { root, write } = await setup();
    await write("archive", record({ status: "completed", heartbeatAt: "2026-10-15T00:59:00Z", completedAt: "2026-10-15T00:59:00Z" }));
    let alive = true;
    const receipt = { id: "run-1", status: "running", pid: 42 } as WorkItemRunRecord;
    const adapter = createExecutionRuntimeAdapter({ taskRuntime: createTaskRuntimePort({ root, now: () => now }), readReceipt: async () => receipt, isPidAlive: () => alive, now: () => now });
    expect(projectRuntimeHealth("run-1", await adapter.read("run-1", workItemId), now).state).toBe("live");
    alive = false;
    expect(projectRuntimeHealth("run-1", await adapter.read("run-1", workItemId), now).state).toBe("exited");
  });
  it("reads a record that predates the environment fields without inventing them", async () => {
    const { root, write } = await setup();
    await write("active", record({ status: "completed", heartbeatAt: "2026-10-15T00:59:00Z", completedAt: "2026-10-15T00:59:00Z" }));
    const adapter = createExecutionRuntimeAdapter({ taskRuntime: createTaskRuntimePort({ root, now: () => now }), readReceipt: async () => undefined, now: () => now });
    const observation = await adapter.read("run-1", workItemId);
    expect(observation).toMatchObject({ runId: "run-1", status: "completed", heartbeatAt: "2026-10-15T00:59:00Z" });
    expect(observation?.provider).toBeUndefined();
    expect(observation?.transport).toBeUndefined();
    expect(observation?.executionMode).toBeUndefined();
  });
});
