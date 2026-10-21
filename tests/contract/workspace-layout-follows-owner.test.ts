import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AFK_CONFIG_FILE,
  AFK_EXECUTIONS_DIRECTORY,
  AFK_RUNTIME_ARCHIVE_DIRECTORY,
  AFK_RUNTIME_RESOURCES_FILE,
  AFK_RUNTIME_TASKS_DIRECTORY,
  AFK_WORKFLOW_DIRECTORY,
} from "@afk/core";

/**
 * Where AFK keeps its files is one answer. The desktop writes the
 * configuration and the workflow templates, and the runner reads them
 * and writes the execution journal the retro reads back. Each side
 * spelled the path out, so the desktop could save a configuration the
 * runner never read, and write templates the runner never found -
 * while the desktop read back its own and the board showed them as if
 * they were runnable.
 *
 * This test moves the layout the core package publishes and then asks
 * the runner where it looks, and it holds the sides to reading the
 * layout rather than spelling the paths out again.
 */
vi.mock("@afk/core", async importOriginal => {
  const original = await importOriginal<typeof import("@afk/core")>();
  return {
    ...original,
    AFK_CONFIG_FILE: ".afk/afk-config.yml",
    AFK_WORKFLOW_DIRECTORY: ".afk/afk-workflows",
    AFK_EXECUTIONS_DIRECTORY: ".afk/afk-executions",
  };
});

import { findTemplateFile, templateCandidates } from "@afk/execution/domain/templates/loader";
import { loadWorkflowConfig } from "@afk/execution/infrastructure/config/manager";

const SHARED_SOURCES = [
  "packages/afk-execution/src/domain/templates/loader.ts",
  "packages/afk-execution/src/infrastructure/config/manager.ts",
  "packages/afk-execution/src/application/loop/loop-config.ts",
  "packages/afk-execution/src/application/workflows/execute-work-item.ts",
  "packages/afk-execution/src/application/runtime/task-runtime.ts",
  "packages/afk-execution/src/infrastructure/runtime/resource-registry.ts",
  "src/cli/commands/retro.ts",
  "desktop-client/electron/services/desktop-service.ts",
  "desktop-client/electron/adapters/resource-adapter.ts",
  "desktop-client/electron/services/backlog-runtime-service.ts",
  "desktop-client/electron/services/work-item-run-history-service.ts",
];

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

  it("is where the runtime keeps the records the desktop reads", () => {
    // The runtime writes the run records and the resource registry, and
    // the desktop reads both. A path that moved left the desktop showing
    // no run history and no resources, with nothing saying why.
    expect(AFK_RUNTIME_TASKS_DIRECTORY).toBe(".afk/runtime/tasks");
    expect(AFK_RUNTIME_ARCHIVE_DIRECTORY).toBe("archive");
    expect(AFK_RUNTIME_RESOURCES_FILE).toBe(".afk/runtime/resources.sqlite");
  });

  it("is the same layout the desktop writes", async () => {
    // The paths the desktop joins and the paths the runner looks under
    // come from one list, so they cannot drift apart.
    expect(AFK_CONFIG_FILE).toBe(".afk/afk-config.yml");
    expect(AFK_WORKFLOW_DIRECTORY).toBe(".afk/afk-workflows");
    expect(AFK_EXECUTIONS_DIRECTORY).toBe(".afk/afk-executions");
    expect(templateCandidates("review", { projectRoot: "/root", homeDir: "/home" })[0]?.path)
      .toBe(path.join("/root", ".afk", "afk-workflows", "review.yml"));
  });

  it("is not spelled out again where the sides share it", () => {
    // One place says where AFK keeps its files. Another place is a copy,
    // and a copy is how the desktop ends up writing somewhere the runner
    // never looks.
    const root = process.cwd();
    for (const source of SHARED_SOURCES) {
      const text = readFileSync(path.join(root, source), 'utf8');
      expect(text).not.toMatch(/['"]\.afk['"],\s*['"](executions|workflows|config\.yml|runtime)/);
    }
  });
});
