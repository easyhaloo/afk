import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunEventDraft } from "@afk/core";
import { JsonlEventStore } from "../../../src/infrastructure/observability/jsonl-event-store";
import { test, expect, E2E_HOME_PATH } from "./_helpers/launch";

test("keeps healthy audited runs visible when other streams fail integrity or replay", async ({ page }) => {
  const root = path.join(E2E_HOME_PATH, ".afk", "events");
  const store = new JsonlEventStore({ root });
  const workItemId = "github:acme/api#1";
  const requested = (runId: string): RunEventDraft => ({
    id: `event-${runId}`, schemaVersion: 1, type: "run.requested",
    occurredAt: "2026-10-10T00:00:00.000Z", correlationId: runId,
    context: { traceId: runId, runId, workItemId, profileId: "default", attempt: 1, actor: { kind: "cli", id: "e2e" } },
    data: { kind: "run.requested", run: { id: runId, workItemId, profileId: "default", attempt: 1, status: "pending" } },
  });
  await store.append([requested("healthy-run")]);
  await store.append([requested("attempt-1")]);
  const corruptedPath = path.join(root, `${Buffer.from("attempt-1").toString("base64url")}.jsonl`);
  const corrupted = JSON.parse(await readFile(corruptedPath, "utf8"));
  corrupted.integrity.hash = "tampered";
  const corruptedContent = `${JSON.stringify(corrupted)}\n`;
  await writeFile(corruptedPath, corruptedContent);
  await store.append([{ ...requested("non-replayable"), type: "qa.started", data: { kind: "qa.started" } }]);

  await expect(store.verify("attempt-1")).resolves.toMatchObject({ valid: false, reason: "integrity_mismatch" });
  const result = await page.evaluate(workItemId => window.afkDesktop.workItems.executions({ workItemId }), workItemId);
  expect(result.executions.map(run => run.runId)).toEqual(["healthy-run"]);
  await page.locator(".backlog-row.work-item-row", { hasText: "API 登录态切换" }).click();
  const detail = page.getByRole("dialog", { name: `工作项 ${workItemId}` });
  await detail.getByRole("button", { name: /运行记录/ }).click();
  await expect(detail.locator(".work-item-run-card")).toHaveCount(1);
  await expect(detail.locator(".work-item-run-card")).toContainText("healthy-run");
  await expect(detail.locator(".work-item-run-error")).toHaveCount(0);
  expect(await readFile(corruptedPath, "utf8")).toBe(corruptedContent);
  await expect(store.verify("attempt-1")).resolves.toMatchObject({ valid: false, reason: "integrity_mismatch" });
});
