import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunEventQueryAdapter } from "../../electron/adapters/run-event-query-adapter";
import { createWorkItemExecutionQueryService } from "../../electron/services/work-item-execution-query-service";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}

describe("desktop read-only event store", () => {
  it("reads the signed JSONL stream and queries application execution history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "afk-event-query-"));
    directories.push(directory);
    const runId = "run:1";
    const draft = {
      id: "event-1", schemaVersion: 1, type: "run.requested", sequence: 1,
      occurredAt: "2026-09-29T00:00:00.000Z", observedAt: "2026-09-29T00:00:00.000Z",
      correlationId: runId,
      context: { traceId: "trace-1", runId, workItemId: "github:team/repo#1", profileId: "default", attempt: 1, actor: { kind: "cli", id: "user" } },
      data: { kind: "run.requested", run: { id: runId, workItemId: "github:team/repo#1", profileId: "default", attempt: 1, status: "pending" } },
    };
    const hash = createHash("sha256").update(stableJson({ ...draft, integrity: {} })).digest("hex");
    const file = join(directory, `${Buffer.from(runId).toString("base64url")}.jsonl`);
    await writeFile(file, `${JSON.stringify({ ...draft, integrity: { hash } })}\n`);
    const events = createRunEventQueryAdapter(directory);
    expect(await events.verify(runId)).toMatchObject({ valid: true, lastSequence: 1, lastHash: hash });
    const readFile = vi.spyOn(fs, "readFile");
    const stream = [];
    for await (const event of events.read(runId)) stream.push(event);
    expect(stream).toHaveLength(1);
    expect(readFile).toHaveBeenCalledTimes(1);
    readFile.mockRestore();
    expect((await createWorkItemExecutionQueryService(events).list()).executions[0]).toMatchObject({ runId, workItemId: draft.context.workItemId, status: "pending" });

    await writeFile(file, `${JSON.stringify({ ...draft, integrity: { hash: "tampered" } })}\n`);
    expect(await events.verify(runId)).toMatchObject({ valid: false, reason: "integrity_mismatch" });
    await expect(createWorkItemExecutionQueryService(events).list()).rejects.toThrow(/integrity/);
  });

  it("returns an empty history when the event directory does not exist", async () => {
    const directory = join(tmpdir(), `afk-event-query-absent-${Date.now()}-${Math.random()}`);
    expect((await createWorkItemExecutionQueryService(createRunEventQueryAdapter(directory)).list()).executions).toEqual([]);
  });
});
