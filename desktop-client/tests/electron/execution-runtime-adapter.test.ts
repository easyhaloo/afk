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

describe("execution runtime observations", () => {
  it("reads exact identities and separates stale health from the audit outcome", async () => {
    const { root, write } = await setup();
    await write("active", { runId: "run-1", providerRef: workItemId, status: "running", heartbeatAt: "2026-10-15T00:00:00Z", agentProvider: "codex", executionMode: "batch", agentTransport: "exec" });
    const adapter = createExecutionRuntimeAdapter({ runtimeRoot: root, readReceipt: async () => undefined, now: () => now });
    expect(projectRuntimeHealth("run-1", await adapter.read("run-1", workItemId), now)).toMatchObject({ state: "stale", provider: "codex", executionMode: "batch" });
    expect(await adapter.read("run-1", "github:other/repo#1")).toBeUndefined();
    await write("active", { runId: "other-run", status: "running", heartbeatAt: "2026-10-15T01:00:00Z" });
    expect(await adapter.read("run-1", workItemId)).toBeUndefined();
  });
  it("keeps a root Runner live after an implementation archive and marks its actual exit", async () => {
    const { root, write } = await setup();
    await write("archive", { runId: "run-1", providerRef: workItemId, status: "completed", heartbeatAt: "2026-10-15T00:59:00Z", completedAt: "2026-10-15T00:59:00Z" });
    let alive = true;
    const receipt = { id: "run-1", status: "running", pid: 42 } as WorkItemRunRecord;
    const adapter = createExecutionRuntimeAdapter({ runtimeRoot: root, readReceipt: async () => receipt, isPidAlive: () => alive, now: () => now });
    expect(projectRuntimeHealth("run-1", await adapter.read("run-1", workItemId), now).state).toBe("live");
    alive = false;
    expect(projectRuntimeHealth("run-1", await adapter.read("run-1", workItemId), now).state).toBe("exited");
  });
});
