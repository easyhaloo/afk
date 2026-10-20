import { promises as fs } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signEvent } from "@afk/infrastructure/observability";
import { createRunEventQueryAdapter } from "../../electron/adapters/run-event-query-adapter";
import { createWorkItemExecutionQueryService } from "../../electron/services/work-item-execution-query-service";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

const runId = "run:1";
const context = { traceId: "trace-1", runId, workItemId: "github:team/repo#1", profileId: "default", attempt: 1, actor: { kind: "cli" as const, id: "user" } };

function requested() {
  return {
    id: "event-1", schemaVersion: 1 as const, type: "run.requested" as const, sequence: 1,
    occurredAt: "2026-09-29T00:00:00.000Z", observedAt: "2026-09-29T00:00:00.000Z",
    correlationId: runId, context,
    data: { kind: "run.requested" as const, run: { id: runId, workItemId: context.workItemId, profileId: "default", attempt: 1, status: "pending" as const } },
  };
}

function started() {
  return {
    id: "event-2", schemaVersion: 1 as const, type: "run.started" as const, sequence: 2,
    occurredAt: "2026-09-29T00:01:00.000Z", observedAt: "2026-09-29T00:01:00.000Z",
    correlationId: runId, context,
    data: { kind: "run.started" as const },
  };
}

describe("desktop read-only event store", () => {
  it("reads the signed JSONL stream and queries application execution history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "afk-event-query-"));
    directories.push(directory);
    const first = signEvent(requested());
    const second = signEvent(started(), first);
    const file = join(directory, `${Buffer.from(runId).toString("base64url")}.jsonl`);
    await writeFile(file, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
    const events = createRunEventQueryAdapter(directory);
    expect(await events.verify(runId)).toMatchObject({ valid: true, lastSequence: 2, lastHash: second.integrity.hash });
    const readFile = vi.spyOn(fs, "readFile");
    const stream = [];
    for await (const event of events.read(runId)) stream.push(event);
    expect(stream).toHaveLength(2);
    expect(readFile).toHaveBeenCalledTimes(1);
    readFile.mockRestore();
    expect((await createWorkItemExecutionQueryService(events).list()).executions[0]).toMatchObject({ runId, workItemId: context.workItemId, status: "running", integrityValid: true });
  });

  it("keeps a run whose tail was tampered with, marked as not intact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "afk-event-query-"));
    directories.push(directory);
    const first = signEvent(requested());
    const second = signEvent(started(), first);
    const file = join(directory, `${Buffer.from(runId).toString("base64url")}.jsonl`);
    // The second event's hash no longer matches what it claims to be.
    await writeFile(file, `${JSON.stringify(first)}\n${JSON.stringify({ ...second, integrity: { ...second.integrity, hash: "tampered" } })}\n`);
    const events = createRunEventQueryAdapter(directory);

    expect(await events.verify(runId)).toMatchObject({ valid: false, reason: "integrity_mismatch", lastSequence: 1 });
    // The run stays visible and says so. It used to vanish from the list.
    const page = await createWorkItemExecutionQueryService(events).list();
    expect(page.executions).toHaveLength(1);
    expect(page.executions[0]).toMatchObject({ runId, status: "pending", integrityValid: false });
    // The detail view refuses to replay it, and says why.
    await expect(createWorkItemExecutionQueryService(events).detail(runId, context.workItemId))
      .rejects.toThrow(/not replayable/);
  });

  it("returns an empty history when the event directory does not exist", async () => {
    const directory = join(tmpdir(), `afk-event-query-absent-${Date.now()}-${Math.random()}`);
    expect((await createWorkItemExecutionQueryService(createRunEventQueryAdapter(directory)).list()).executions).toEqual([]);
  });
});
