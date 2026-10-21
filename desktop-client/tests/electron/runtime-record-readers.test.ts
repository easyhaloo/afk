import { createTaskRuntimePort } from "@afk/execution/application/runtime/task-runtime-port";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectRuntimeHealth } from "@afk/application";
import type { BacklogItem, BacklogRunSummary } from "../../shared/backlog-contract";
import { createExecutionRuntimeAdapter } from "../../electron/adapters/execution-runtime-adapter";
import { createBacklogRuntimeService } from "../../electron/services/backlog-runtime-service";

/**
 * The two desktop surfaces read the same runtime records. They used to do
 * it themselves, with two sets of hand-written rules, so the same record
 * could be shown by one view and hidden by the other.
 */

const roots: string[] = [];
const now = Date.parse("2026-09-15T00:10:00.000Z");
const providerRef = "stub:42";
/** The runtime names a record file after the run id it belongs to. */
const runKey = Buffer.from("run-42", "utf8").toString("base64url");

const backlog: BacklogItem = {
  id: "42",
  title: "Ship runtime summary",
  dependsOn: [],
  state: "ready",
  executionMode: "afk",
  tags: [],
  branchName: "afk/backlog-42",
  providerRef,
};

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "afk-runtime-readers-"));
  roots.push(root);
  await mkdir(path.join(root, "active"), { recursive: true });
  await mkdir(path.join(root, "archive"), { recursive: true });
  return root;
}

/** A record as the runtime writes it. */
function record(root: string, overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-42",
    backlogId: "42",
    phase: "implementing",
    status: "running",
    providerRef,
    workspace: root,
    startedAt: "2026-09-15T00:08:00.000Z",
    heartbeatAt: "2026-09-15T00:09:00.000Z",
    sandboxProvider: "local",
    executionMode: "batch",
    agentProvider: "codex",
    ...overrides,
  };
}

async function write(root: string, bucket: "active" | "archive", name: string, value: unknown) {
  await writeFile(path.join(root, bucket, `${name}.json`), JSON.stringify(value));
}

function surfaces(root: string) {
  const adapter = createExecutionRuntimeAdapter({ taskRuntime: createTaskRuntimePort({ root, now: () => now }), readReceipt: async () => undefined, now: () => now });
  const service = createBacklogRuntimeService({
    resolveWorkspace: value => value,
    getBacklog: async () => backlog,
    runStore: { load: async () => [] as BacklogRunSummary[] } as never,
    taskRuntime: createTaskRuntimePort({ root, now: () => now }),
    now: () => now,
  });
  return { adapter, service };
}

describe("the desktop surfaces read one runtime record", () => {
  it("answers the same for the same record", async () => {
    const root = await fixture();
    await write(root, "active", runKey, record(root));
    const { adapter, service } = surfaces(root);

    const observation = await adapter.read("run-42", providerRef);
    const projection = (await service.summary(root, "42")).runtime;

    expect(observation).toMatchObject({ runId: "run-42", status: "running", heartbeatAt: "2026-09-15T00:09:00.000Z" });
    expect(projection).toMatchObject({ runId: "run-42", status: "running", heartbeatAt: "2026-09-15T00:09:00.000Z" });
    expect(projection?.runId).toBe(observation?.runId);
    expect(projection?.status).toBe(observation?.status);
    expect(projection?.heartbeatAt).toBe(observation?.heartbeatAt);
  });

  it("both read a record written before the environment fields existed, and claim nothing it does not know", async () => {
    const root = await fixture();
    await write(root, "active", runKey, record(root, {
      sandboxProvider: undefined,
      executionMode: undefined,
      agentProvider: undefined,
    }));
    const { adapter, service } = surfaces(root);

    const observation = await adapter.read("run-42", providerRef);
    const projection = (await service.summary(root, "42")).runtime;

    expect(observation).toMatchObject({ runId: "run-42", status: "running" });
    expect(projection).toMatchObject({ runId: "run-42", status: "running" });
    expect(observation?.provider).toBeUndefined();
    expect(observation?.transport).toBeUndefined();
    expect(observation?.executionMode).toBeUndefined();
  });

  it("both hide a record that belongs to another work item", async () => {
    const root = await fixture();
    await write(root, "active", runKey, record(root, { providerRef: "stub:99" }));
    const { adapter, service } = surfaces(root);

    expect(await adapter.read("run-42", providerRef)).toBeUndefined();
    expect((await service.summary(root, "42")).runtime).toBeUndefined();
  });

  it("both call a run with a cold heartbeat stale", async () => {
    const root = await fixture();
    await write(root, "active", runKey, record(root, { heartbeatAt: "2026-09-14T23:00:00.000Z" }));
    const { adapter, service } = surfaces(root);

    const observation = await adapter.read("run-42", providerRef);
    const projection = (await service.summary(root, "42")).runtime;

    // The backlog projection carries the shared staleness rule; the run
    // detail carries the record's own status, and the health projection
    // judges the same heartbeat cold.
    expect(projection?.status).toBe("stale");
    expect(observation?.status).toBe("running");
    expect(projectRuntimeHealth("run-42", observation, now).state).toBe("stale");
  });
});
