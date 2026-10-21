import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readWorkflowRuns } from "../../electron/services/desktop-service.js";

async function runWithStatus(status: string | undefined): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "afk-desktop-runs-"));
  const dir = path.join(root, ".afk", "runs", "run-1");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "request.json"), JSON.stringify({ runId: "run-1", startedAt: "2026-10-17T00:00:00.000Z" }), "utf8");
  await writeFile(path.join(dir, "result.json"), JSON.stringify(status === undefined ? {} : { status }), "utf8");
  const runs = await readWorkflowRuns(root);
  return runs[0]?.status ?? "";
}

describe("the workflow runs the desktop reads", () => {
  it("reports a run whose recorded status it knows", async () => {
    expect(await runWithStatus("completed")).toBe("completed");
    expect(await runWithStatus("timed_out")).toBe("timed_out");
  });

  it("reports a run with no result yet as still going", async () => {
    expect(await runWithStatus(undefined)).toBe("running");
  });

  it("says it does not know rather than claiming the run is going", async () => {
    // A run whose status the desktop does not recognise has not been
    // shown to be running. Reporting it as running was a claim the
    // desktop could not back, and it left a finished run looking alive.
    expect(await runWithStatus("quantum")).toBe("unknown");
  });
});
