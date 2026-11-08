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
