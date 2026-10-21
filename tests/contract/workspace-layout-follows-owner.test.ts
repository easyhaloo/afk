import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AFK_CONFIG_FILE, AFK_WORKFLOW_DIRECTORY } from "@afk/core";

/**
 * Where AFK keeps its files is one answer. The desktop writes the
 * configuration and the workflow templates, and the runner reads them.
 * Each side spelled the path out, so the desktop could save a
 * configuration the runner never read, and write templates the runner
 * never found - while the desktop read back its own and the board
 * showed them as if they were runnable.
 *
 * This test moves the layout the core package publishes and then asks
 * the runner where it looks.
 */
vi.mock("@afk/core", async importOriginal => {
  const original = await importOriginal<typeof import("@afk/core")>();
  return {
    ...original,
    AFK_CONFIG_FILE: ".afk/afk-config.yml",
    AFK_WORKFLOW_DIRECTORY: ".afk/afk-workflows",
  };
});

import { findTemplateFile, templateCandidates } from "@afk/execution/domain/templates/loader";
import { loadWorkflowConfig } from "@afk/execution/infrastructure/config/manager";

describe("where AFK keeps its files", () => {
  it("is where the runner looks for a template", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "afk-layout-"));
    const directory = path.join(root, ".afk", "afk-workflows");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "review.yml"), "name: review\nversion: 1\nsteps:\n  - id: only\n    role: implementer\n    prompt: hi\n", "utf8");

    const found = await findTemplateFile("review", { projectRoot: root, homeDir: root });
    expect(found?.baseDir).toBe(path.join(root, ".afk", "afk-workflows"));
    expect(found?.template.name).toBe("review");
  });

  it("is where the runner looks for the configuration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "afk-layout-config-"));
    await mkdir(path.join(root, ".afk"), { recursive: true });
    await writeFile(path.join(root, ".afk", "afk-config.yml"), "agentDefault: codex\n", "utf8");

    const config = loadWorkflowConfig(root);
    expect(config.agentDefault).toBe("codex");
  });

  it("is the same layout the desktop writes", async () => {
    // The paths the desktop joins and the paths the runner looks under
    // come from one list, so they cannot drift apart.
    expect(AFK_CONFIG_FILE).toBe(".afk/afk-config.yml");
    expect(AFK_WORKFLOW_DIRECTORY).toBe(".afk/afk-workflows");
    expect(templateCandidates("review", { projectRoot: "/root", homeDir: "/home" })[0]?.path)
      .toBe(path.join("/root", ".afk", "afk-workflows", "review.yml"));
  });
});
