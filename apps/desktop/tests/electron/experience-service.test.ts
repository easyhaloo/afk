import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExperienceStore } from "@afk/runtime/execution";
import { createExperienceService } from "../../electron/services/experience-service.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "afk-desktop-experience-"));
  directories.push(directory);
  const file = path.join(directory, "experience.sqlite");
  const store = new ExperienceStore({ file });
  const record = store.recordFailure({ scope: "github:acme/api", trigger: "network.failure", rootCause: "network timeout", action: "set proxy", evidence: ["run:original#failure.classified"], source: { runId: "original", workItemId: "github:acme/api#1" } });
  store.close();
  const verifyRun = vi.fn().mockImplementation(async ({ runId }) => [`run:${runId}#qa.passed`]);
  const projects = vi.fn().mockResolvedValue(["github:acme/api", "github:acme/other"]);
  return { file, record, projects, verifyRun, service: createExperienceService({ file, projects, verifyRun }) };
}

describe("desktop experience service", () => {
  it("queries actual outcome receipts with bounded safe DTOs and no verification or extra content", async () => {
    const { file, service, record, projects, verifyRun } = await setup();
    const store = new ExperienceStore({ file, now: () => new Date(record.createdAt) });
    const source = { runId: "consumer", workItemId: "github:acme/api#2" };
    const occurredAt = new Date(Date.parse(record.createdAt) + 1000).toISOString();
    const observedAt = new Date(Date.parse(record.createdAt) + 2000).toISOString();
    store.verify(record.id, { runId: "independent-qa", action: "configure proxy", evidence: ["run:independent-qa#qa.passed"] });
    const retrieved = store.recordContextRetrieval({ id: record.id, scope: record.scope, source,
      selectionId: "11111111-1111-4111-8111-111111111111", fragmentDigest: "a".repeat(64) });
    store.recordContextSelection({ retrieved, fragmentDigest: "b".repeat(64) });
    store.recordRunOutcome({ scope: record.scope, source, event: { runId: source.runId, sequence: 7,
      hash: "c".repeat(64), type: "run.finished", outcome: "succeeded", occurredAt, observedAt } });
    store.close();
    projects.mockClear();
    const result = await service.outcomes({ scope: record.scope, ...source });
    expect(result).toEqual([{ experienceId: record.id, selectionId: retrieved.selectionId, ...source,
      event: { sequence: 7, type: "run.finished", outcome: "succeeded", occurredAt },
      recurrence: false, benefit: "unknown", recordedAt: expect.any(String) }]);
    expect(projects).toHaveBeenCalledTimes(2);
    expect(verifyRun).not.toHaveBeenCalled();
    expect(await service.outcomes({ scope: record.scope, ...source, limit: 0 })).toEqual([]);
    expect(await service.outcomes({ scope: record.scope, ...source, runId: "unknown" })).toEqual([]);
    expect(await service.outcomes({ scope: record.scope, ...source, workItemId: "github:acme/api#3" })).toEqual([]);
  });

  it("rejects unauthorized and cross-project outcome queries without reading storage", async () => {
    const { service, projects, record } = await setup();
    const read = vi.spyOn(ExperienceStore.prototype, "outcomeReceipts");
    try {
      await expect(service.outcomes({ scope: record.scope, runId: "run", workItemId: "github:acme/other#2" })).rejects.toThrow();
      projects.mockResolvedValue([]);
      await expect(service.outcomes({ scope: record.scope, runId: "run", workItemId: `${record.scope}#2` })).rejects.toThrow("不在当前工作项来源");
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });

  it("projects only approved outcome and publication fields without private audit metadata", async () => {
    const { service, record } = await setup();
    const source = { runId: "consumer", workItemId: `${record.scope}#2` };
    const publication = { key: "a".repeat(64), candidateId: "b".repeat(64), validatedVersion: 3,
      candidateDigest: "c".repeat(64), evidenceDigest: "d".repeat(64), validatorVersion: "PRIVATE_VALIDATOR", targetRef: "PRIVATE_TARGET" };
    const receipt = { version: 1 as const, stage: "outcome" as const,
      selected: { version: 1 as const, stage: "selected" as const, experienceId: record.id, scope: record.scope, source,
        selectionId: "11111111-1111-4111-8111-111111111111", verificationDigest: "e".repeat(64), contextDigest: "f".repeat(64),
        fragmentDigest: "a".repeat(64), retrievedFragmentDigest: "b".repeat(64), publication, recordedAt: "2026-11-17T00:00:00Z" },
      event: { ...source, sequence: 8, hash: "c".repeat(64), type: "failure.classified" as const, outcome: "failed" as const,
        occurredAt: "2026-11-17T00:00:00Z", observedAt: "2026-11-17T00:00:01Z", content: "PRIVATE_EVENT" },
      recurrence: true, benefit: "unknown" as const, recordedAt: "2026-11-17T00:00:02Z", error: "PRIVATE_ERROR" };
    const read = vi.spyOn(ExperienceStore.prototype, "outcomeReceipts").mockReturnValueOnce([receipt]);
    try {
      const result = await service.outcomes({ scope: record.scope, ...source, limit: 100 });
      expect(result).toEqual([{ experienceId: record.id, selectionId: receipt.selected.selectionId, ...source,
        event: { sequence: 8, type: "failure.classified", outcome: "failed", occurredAt: receipt.event.occurredAt },
        recurrence: true, benefit: "unknown", recordedAt: receipt.recordedAt,
        publication: { key: publication.key, candidateId: publication.candidateId, validatedVersion: 3 } }]);
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
      expect(read).toHaveBeenCalledWith({ scope: record.scope, source, limit: 100 });
    } finally { read.mockRestore(); }
  });

  it("closes storage and rejects an outcome response when project authorization is removed after reading", async () => {
    const { service, projects, record } = await setup();
    projects.mockResolvedValueOnce([record.scope]).mockResolvedValueOnce([]);
    const close = vi.spyOn(ExperienceStore.prototype, "close");
    try {
      await expect(service.outcomes({ scope: record.scope, runId: "run", workItemId: `${record.scope}#2` })).rejects.toThrow("不在当前工作项来源");
      expect(close).toHaveBeenCalledTimes(1);
    } finally { close.mockRestore(); }
  });

  it("sanitizes outcome storage failures and still closes the store", async () => {
    const { service, record } = await setup();
    const read = vi.spyOn(ExperienceStore.prototype, "outcomeReceipts").mockImplementationOnce(() => { throw new Error("SECRET /private/credential"); });
    const close = vi.spyOn(ExperienceStore.prototype, "close");
    try {
      await expect(service.outcomes({ scope: record.scope, runId: "run", workItemId: `${record.scope}#2` })).rejects.toThrow("经验操作失败");
      expect(close).toHaveBeenCalledTimes(1);
    } finally { read.mockRestore(); close.mockRestore(); }
  });

  it("does not return receipts or private errors when closing the store fails", async () => {
    const { service, record } = await setup();
    const original = ExperienceStore.prototype.close;
    const close = vi.spyOn(ExperienceStore.prototype, "close").mockImplementationOnce(function (this: ExperienceStore) {
      original.call(this);
      throw new Error("PRIVATE_CLOSE_ERROR");
    });
    try {
      await expect(service.outcomes({ scope: record.scope, runId: "run", workItemId: `${record.scope}#2` })).rejects.toThrow("经验操作失败");
    } finally { close.mockRestore(); }
  });

  it("lists scoped DTOs, recalls verified records and removes revoked records from recall", async () => {
    const { service, record } = await setup();
    const selection = { scope: record.scope, id: record.id };
    expect(await service.list({ scope: record.scope })).toEqual([expect.objectContaining({ id: record.id, status: "candidate" })]);
    expect((await service.list({ scope: record.scope }))[0]).not.toHaveProperty("fingerprint");
    expect(await service.list({ scope: record.scope, prompt: "network" })).toEqual([]);
    await service.verify({ ...selection, runId: "independent-qa", action: "configure network proxy" });
    expect(await service.list({ scope: record.scope, prompt: "network" })).toEqual([expect.objectContaining({ status: "verified", action: "configure network proxy" })]);
    expect(await service.revoke(selection)).toMatchObject({ status: "revoked", verifiedEvidence: { runId: "independent-qa" } });
    expect(await service.list({ scope: record.scope, prompt: "network" })).toEqual([]);
    await expect(service.verify({ ...selection, runId: "another-qa", action: "fix" })).rejects.toThrow("已撤销");
  });

  it("rechecks inventory membership and refuses cross-project record mutations", async () => {
    const { service, projects, verifyRun, record } = await setup();
    await expect(service.list({ scope: "github:unknown/repo" })).rejects.toThrow("不在当前工作项来源");
    const input = { scope: "github:acme/other", id: record.id };
    await expect(service.revoke(input)).rejects.toThrow("当前项目中找不到");
    await expect(service.verify({ ...input, runId: "qa", action: "fix" })).rejects.toThrow("当前项目中找不到");
    expect(verifyRun).not.toHaveBeenCalled();
    projects.mockResolvedValueOnce([]);
    await expect(service.revoke({ scope: record.scope, id: record.id })).rejects.toThrow("不在当前工作项来源");
  });

  it("requires runtime audit validation plus an independent run and newly generated QA evidence", async () => {
    const { service, verifyRun, record } = await setup();
    const input = { scope: record.scope, id: record.id, runId: "original", action: "fix network" };
    await expect(service.verify(input)).rejects.toThrow("独立 QA");
    verifyRun.mockRejectedValueOnce(new Error("Experience verification requires an intact recorded run"));
    await expect(service.verify({ ...input, runId: "bad-qa" })).rejects.toThrow("独立 QA");
    expect((await service.list({ scope: record.scope }))[0].status).toBe("candidate");
    await service.verify({ ...input, runId: "good-qa" });
    expect(verifyRun).toHaveBeenLastCalledWith({ scope: record.scope, runId: "good-qa", evidence: [] });
  });

  it("bounds IPC data and sanitizes storage and project discovery failures", async () => {
    const { service, projects, verifyRun, record } = await setup();
    await expect(service.list({ scope: record.scope, prompt: "x".repeat(2001) })).rejects.toThrow();
    await expect(service.revoke({ scope: record.scope, id: "../escape" })).rejects.toThrow();
    verifyRun.mockRejectedValueOnce(new Error("SECRET path=/private/credentials"));
    await expect(service.verify({ scope: record.scope, id: record.id, runId: "qa", action: "fix" })).rejects.toThrow("审计记录");
    projects.mockRejectedValueOnce(new Error("SECRET"));
    await expect(service.projects()).rejects.toThrow("Provider 配置");
  });

  it("uses the public runtime verifier by default and rejects a run without intact audit evidence", async () => {
    const { file, record, projects } = await setup();
    const service = createExperienceService({ file, projects });
    await expect(service.verify({ scope: record.scope, id: record.id, runId: "missing-audit", action: "fix network" })).rejects.toThrow("独立 QA");
    expect((await service.list({ scope: record.scope }))[0].status).toBe("candidate");
  });
});
