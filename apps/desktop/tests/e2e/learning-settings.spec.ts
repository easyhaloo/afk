import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { E2E_ENTRY, RENDERER_URL } from "./_helpers/launch.js";
import { createLearningFixture, type LearningFixture } from "./_helpers/learning.js";

async function launchLearning(fixture: LearningFixture) {
  const display: Record<string, string> = {};
  for (const name of ["DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "SystemRoot"]) {
    if (process.env[name]) display[name] = process.env[name]!;
  }
  const app = await electron.launch({
    args: [E2E_ENTRY, `--user-data-dir=${path.join(fixture.temporary, "user-data")}`],
    env: { ...fixture.env, ...display, CI: "", AFK_E2E_NO_WINDOW: "1", AFK_E2E_PRODUCTION_MAIN: "1",
      AFK_WORKSPACE: fixture.workspace, ELECTRON_RENDERER_URL: RENDERER_URL },
    timeout: 30_000,
  });
  try {
    const page = await app.firstWindow();
    await expect(page.locator(".primary-nav")).toBeVisible();
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true);
    const snapshot = await page.evaluate(() => window.afkDesktop.snapshot(""));
    expect(snapshot.afk).toMatchObject({ available: true, executable: "@afk/runtime" });
    expect(snapshot.workspace.root).toBe(fixture.workspace);
    expect(await page.evaluate(() => typeof window.afkDesktop.learning.validate)).toBe("function");
    expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe("undefined");
    return { app, page };
  } catch (error) {
    await app.close();
    throw error;
  }
}

test.describe("production Main learning IPC with a deterministic saved oracle (no live model)", () => {
  test("preserves display authentication while isolating unrelated parent environment", async () => {
    const fixture = await createLearningFixture();
    const previousAuthority = process.env.XAUTHORITY;
    const previousUnrelated = process.env.AFK_E2E_UNRELATED_SECRET;
    process.env.XAUTHORITY = previousAuthority ?? path.join(path.dirname(E2E_ENTRY), "unused-xauthority");
    process.env.AFK_E2E_UNRELATED_SECRET = "must-not-reach-electron";
    let app: ElectronApplication | undefined;
    try {
      app = (await launchLearning(fixture)).app;
      const environment = await app.evaluate(() => ({ authority: process.env.XAUTHORITY,
        unrelated: process.env.AFK_E2E_UNRELATED_SECRET, home: process.env.HOME }));
      expect(environment.authority).toBe(process.env.XAUTHORITY);
      expect(environment.unrelated).toBeUndefined();
      expect(environment.home).toBe(fixture.env.HOME);
    } finally {
      if (previousAuthority === undefined) delete process.env.XAUTHORITY;
      else process.env.XAUTHORITY = previousAuthority;
      if (previousUnrelated === undefined) delete process.env.AFK_E2E_UNRELATED_SECRET;
      else process.env.AFK_E2E_UNRELATED_SECRET = previousUnrelated;
      try { await app?.close(); } finally { fixture.cleanup(); }
    }
  });

  test.setTimeout(120_000);

  test("uses Settings to validate, publish and withdraw actual Wiki content after source invalidation", async () => {
    const fixture = await createLearningFixture();
    let app: ElectronApplication | undefined;
    try {
      const initial = await fixture.inspect();
      expect(initial).toMatchObject({ candidate: { state: "candidate", version: 1 }, receipt: null, publications: [] });
      const navigation = fixture.navigation();
      expect(existsSync(fixture.asset)).toBe(false);
      const launched = await launchLearning(fixture);
      app = launched.app;
      const { page } = launched;
      expect(await page.evaluate(() => window.afkDesktop.learning.projects())).toContain(fixture.scope);
      expect(await page.evaluate(scope => window.afkDesktop.learning.candidates({ scope }), fixture.scope))
        .toEqual([expect.objectContaining({ id: fixture.candidateId, state: "candidate", version: 1 })]);
      expect(await page.evaluate(() => window.afkDesktop.learning.candidates({ scope: "github:acme/web" }))).toEqual([]);
      const selection = { scope: fixture.scope, candidateId: fixture.candidateId, expectedVersion: 1, checkerId: fixture.checkerId };
      await expect(page.evaluate(input => window.afkDesktop.learning.validate(input), { ...selection, expectedVersion: 2 })).rejects.toThrow();
      await expect(page.evaluate(input => window.afkDesktop.learning.validate(input), { ...selection, scope: "github:acme/web" })).rejects.toThrow();
      await expect(page.evaluate(input => window.afkDesktop.learning.knowledge.prepare(input), {
        scope: fixture.scope, candidateId: fixture.candidateId, expectedVersion: 1,
      })).rejects.toThrow();
      expect(fixture.calls()).toEqual([]);
      expect(await fixture.inspect()).toEqual(initial);

      await page.locator(".sidebar-bottom .settings-entry").click();
      const learning = page.getByRole("region", { name: "学习治理", exact: true });
      await expect(learning).toBeVisible();
      await learning.getByRole("button", { name: "学习项目", exact: true }).click();
      await learning.getByRole("combobox", { name: "搜索学习项目", exact: true }).fill(fixture.scope);
      await learning.getByRole("option", { name: fixture.scope, exact: true }).click();
      const candidate = learning.getByRole("button", { name: `选择候选 ${fixture.candidateId}`, exact: true });
      await candidate.click();
      await expect(candidate).toContainText("待验证 · v1");
      await expect(learning.getByRole("button", { name: "准备知识预览", exact: true })).toBeDisabled();
      await learning.getByRole("textbox", { name: "验证器 ID", exact: true }).fill(fixture.checkerId);
      await learning.getByRole("button", { name: "验证候选", exact: true }).click();
      await expect(learning.getByRole("status").filter({ hasText: "验证通过 · v1 → v2" })).toBeVisible();
      await expect(candidate).toContainText("已验证 · v2");
      const afterValidation = await fixture.inspect();
      expect(afterValidation.candidate).toMatchObject({ state: "validated", version: 2 });
      expect(afterValidation.receipt).toMatchObject({ candidateId: fixture.candidateId, candidateVersion: 1, validatedVersion: 2,
        candidateDigest: fixture.candidateDigest, evidenceDigest: fixture.evidenceDigest, passed: true,
        validatorVersion: expect.stringMatching(/^learning-validation-v1:.+/) });
      expect(fixture.calls()).toEqual([{ operation: "verify", pid: app.process().pid }]);
      expect(app.process().pid).not.toBe(process.pid);

      await learning.getByRole("button", { name: "准备知识预览", exact: true }).click();
      const previewRegion = learning.getByRole("region", { name: "知识预览", exact: true });
      await expect(previewRegion).toBeVisible();
      const preview = (await fixture.inspect()).publications[0]!;
      expect(preview).toMatchObject({ phase: "prepared", candidateId: fixture.candidateId,
        candidateVersion: 2, targetRef: "wiki:approval" });
      await expect(previewRegion).toContainText(preview.key);
      await expect(previewRegion).toContainText("wiki:approval");
      await expect(previewRegion).toContainText("v2");
      expect(existsSync(fixture.asset)).toBe(false);
      expect(fixture.navigation()).toEqual(navigation);
      expect((await fixture.inspect()).publications).toEqual([expect.objectContaining({ key: preview.key, phase: "prepared" })]);
      const publicationInput = { scope: fixture.scope, key: preview.key };
      await learning.getByRole("button", { name: "发布知识", exact: true }).click();
      const result = learning.getByRole("list", { name: "本次发布结果", exact: true });
      await expect(result).toContainText("已提交");
      await expect(result).toContainText(preview.key);
      await expect(result).not.toContainText("错误码");
      await expect(result).not.toContainText("恢复状态");
      await expect(candidate).toContainText("已发布 · v3");
      const asset = readFileSync(fixture.asset, "utf8");
      expect(asset).toContain("Approve before publishing");
      for (const contents of fixture.navigation()) expect(contents.split("[[知识/Approval]]")).toHaveLength(2);
      const committed = await fixture.inspect();
      expect(committed.candidate).toMatchObject({ state: "published", version: 3 });
      expect(committed.receipt).toEqual(afterValidation.receipt);
      expect(committed.publications).toEqual([expect.objectContaining({ key: preview.key, phase: "committed" })]);
      const publishedNavigation = fixture.navigation();
      const replayed = await page.evaluate(input => window.afkDesktop.learning.knowledge.publish(input), publicationInput);
      expect(replayed).toMatchObject({ publication: { key: preview.key, phase: "committed" } });
      expect(replayed.errorCode).toBeUndefined();
      expect(replayed.withdrawal).toBeUndefined();
      await learning.getByRole("button", { name: "核对知识发布", exact: true }).click();
      const reconciliation = learning.getByRole("list", { name: "核对发布结果", exact: true });
      await expect(reconciliation).toContainText(preview.key);
      await expect(reconciliation).toContainText("已提交");
      const reconciled = await page.evaluate(scope => window.afkDesktop.learning.knowledge.reconcile({ scope }), fixture.scope);
      expect(reconciled.blocked).toEqual([]);
      expect(reconciled.results).toEqual([expect.objectContaining({ publication: expect.objectContaining({ key: preview.key, phase: "committed" }) })]);
      expect(reconciled.results[0]?.withdrawal).toBeUndefined();
      expect(readFileSync(fixture.asset, "utf8")).toBe(asset);
      expect(fixture.navigation()).toEqual(publishedNavigation);
      expect(fixture.calls()).toHaveLength(1);
      expect(await fixture.inspect()).toEqual(committed);
      const context = await fixture.gatherKnowledge();
      expect(context).toEqual([{ origin: expect.stringContaining(preview.key), content: expect.stringContaining("Approve before publishing") }]);

      await fixture.invalidateSource();
      const invalidated = await fixture.inspect();
      expect(invalidated.candidate).toMatchObject({ state: "conflict", version: 4 });
      expect(invalidated.publications).toEqual(committed.publications);
      expect(await fixture.gatherKnowledge()).toEqual([]);
      await learning.getByRole("button", { name: "核对知识发布", exact: true }).click();
      await expect(reconciliation).toContainText("已撤回");
      await expect(reconciliation).toContainText("历史发布阶段：已提交");
      await expect(candidate).toContainText("冲突 · v4");
      await expect(learning.getByRole("status").filter({ hasText: "历史提交不表示当前发布成功" })).toBeVisible();
      expect(readFileSync(fixture.asset, "utf8")).toContain("knowledge_status: revoked");
      expect(fixture.navigation()).toEqual(publishedNavigation);
      expect(await fixture.gatherKnowledge()).toEqual([]);
      const withdrawn = await page.evaluate(scope => window.afkDesktop.learning.knowledge.reconcile({ scope }), fixture.scope);
      expect(withdrawn.blocked).toEqual([]);
      expect(withdrawn.results).toEqual([expect.objectContaining({ publication: expect.objectContaining({ key: preview.key, phase: "committed" }),
        withdrawal: { status: "withdrawn" } })]);
      const staleReplay = await page.evaluate(input => window.afkDesktop.learning.knowledge.publish(input), publicationInput);
      expect(staleReplay.withdrawal).toEqual({ status: "withdrawn" });
      expect(fixture.calls()).toHaveLength(1);
      expect(await fixture.inspect()).toEqual(invalidated);
    } finally {
      try { await app?.close(); } finally { fixture.cleanup(); }
    }
  });

  test("shows missing independent lesson QA without validating or publishing", async () => {
    const fixture = await createLearningFixture("lesson");
    let app: ElectronApplication | undefined;
    try {
      const before = await fixture.inspect();
      const navigation = fixture.navigation();
      const launched = await launchLearning(fixture);
      app = launched.app;
      const { page } = launched;
      const selection = { scope: fixture.scope, candidateId: fixture.candidateId, expectedVersion: 1, checkerId: fixture.checkerId };
      expect(await page.evaluate(input => window.afkDesktop.learning.validate(input), selection))
        .toEqual({ status: "blocked", code: "qa_unconfigured" });
      await page.locator(".sidebar-bottom .settings-entry").click();
      const learning = page.getByRole("region", { name: "学习治理", exact: true });
      await learning.getByRole("button", { name: "学习项目", exact: true }).click();
      await learning.getByRole("combobox", { name: "搜索学习项目", exact: true }).fill(fixture.scope);
      await learning.getByRole("option", { name: fixture.scope, exact: true }).click();
      await learning.getByRole("button", { name: `选择候选 ${fixture.candidateId}`, exact: true }).click();
      await learning.getByRole("textbox", { name: "验证器 ID", exact: true }).fill(fixture.checkerId);
      await learning.getByRole("button", { name: "验证候选", exact: true }).click();
      await expect(learning.getByRole("status").filter({ hasText: "qa_unconfigured" })).toBeVisible();
      await expect(learning.getByRole("button", { name: "准备知识预览", exact: true })).toBeDisabled();
      await expect(learning.getByRole("button", { name: "选择候选 " + fixture.candidateId, exact: true })).toContainText("待验证 · v1");
      expect(fixture.calls()).toEqual([]);
      expect(await fixture.inspect()).toEqual(before);
      expect(existsSync(fixture.asset)).toBe(false);
      expect(fixture.navigation()).toEqual(navigation);
    } finally {
      try { await app?.close(); } finally { fixture.cleanup(); }
    }
  });

  test("rejects a checker observation that disagrees with the candidate instead of accepting passed:true", async () => {
    const fixture = await createLearningFixture();
    let app: ElectronApplication | undefined;
    try {
      fixture.setObservedRule("Publication requires a separate owner review");
      const before = await fixture.inspect();
      const navigation = fixture.navigation();
      const launched = await launchLearning(fixture);
      app = launched.app;
      const result = await launched.page.evaluate(input => window.afkDesktop.learning.validate(input), {
        scope: fixture.scope, candidateId: fixture.candidateId, expectedVersion: 1, checkerId: fixture.checkerId,
      });
      expect(result).toEqual({ status: "blocked", code: "assertion_failed" });
      expect(fixture.calls()).toEqual([{ operation: "verify", pid: app.process().pid }]);
      expect(await fixture.inspect()).toEqual(before);
      expect(existsSync(fixture.asset)).toBe(false);
      expect(fixture.navigation()).toEqual(navigation);
    } finally {
      try { await app?.close(); } finally { fixture.cleanup(); }
    }
  });
});

test("keeps the lesson checker available while a production snapshot is loading", async () => {
  const fixture = await createLearningFixture("lesson");
  let app: ElectronApplication | undefined;
  try {
    const launched = await launchLearning(fixture);
    app = launched.app;
    const result = await launched.page.evaluate(async input => {
      const snapshot = window.afkDesktop.snapshot("");
      const validation = window.afkDesktop.learning.validate(input);
      return (await Promise.all([snapshot, validation]))[1];
    }, { scope: fixture.scope, candidateId: fixture.candidateId, expectedVersion: 1, checkerId: fixture.checkerId });
    expect(result).toEqual({ status: "blocked", code: "qa_unconfigured" });
    expect(fixture.calls()).toEqual([]);
  } finally {
    try { await app?.close(); } finally { fixture.cleanup(); }
  }
});
