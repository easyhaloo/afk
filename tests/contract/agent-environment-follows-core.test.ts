import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from "commander";

/**
 * The environment an agent run happens in - the transport that carries it,
 * the way it authenticates - is a vocabulary with one owner. The command
 * that offers the choice, the configuration that reads it and the desktop
 * that edits it must read the owner's list rather than keeping their own.
 *
 * This test grows the vocabulary the core package publishes and then asks
 * the entry points whether they grew with it. An entry point that keeps
 * its own copy refuses the new value, and that refusal is the defect.
 */
vi.mock("@afk/core", async importOriginal => {
  const original = await importOriginal<typeof import("@afk/core")>();
  return {
    ...original,
    AGENT_TRANSPORT_CHOICES: [...original.AGENT_TRANSPORT_CHOICES, "stdio"],
    AGENT_AUTH_CHOICES: [...original.AGENT_AUTH_CHOICES, "token"],
  };
});

vi.mock("../../desktop-client/electron/adapters/process-executor", () => ({ executable: async () => undefined, firstLine: () => "" }));
vi.mock("../../desktop-client/electron/services/runtime-service", () => ({ detectAgentRuntimes: async () => [] }));
vi.mock("../../desktop-client/electron/services/project-run-scope-service", () => ({ projectRunScopeService: { workspaces: async (root: string) => [root], runs: async () => [] } }));

import { AGENT_AUTH_CHOICES, AGENT_TRANSPORT_CHOICES } from "@afk/core";
import { addAgentRuntimeOptions } from "../../src/cli/commands/agent-runtime-options";
import { createDesktopService } from "../../desktop-client/electron/services/desktop-service";
import { fileConfigurationPort } from "@afk/execution/infrastructure/config/manager";
import { stubResourceAdapter } from "../../desktop-client/tests/electron/port-stubs";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "afk-agent-environment-"));
  vi.stubEnv("HOME", directory);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("The entry points answer with the agent environment vocabulary the core publishes", () => {
  it("names every transport the core package declares in the command", () => {
    const program = new Command();
    addAgentRuntimeOptions(program);
    const transport = program.options.find(option => option.long === "--agent-transport");
    for (const value of AGENT_TRANSPORT_CHOICES) {
      expect(transport?.description).toContain(value);
    }
  });

  it("names every authentication mode the core package declares in the command", () => {
    const program = new Command();
    addAgentRuntimeOptions(program);
    const auth = program.options.find(option => option.long === "--agent-auth");
    for (const value of AGENT_AUTH_CHOICES) {
      expect(auth?.description).toContain(value);
    }
  });

  it("lets the desktop save every transport the core package declares", async () => {
    // The desktop reads the configuration through the port, so what it
    // writes and what it reads back are the same configuration - the one
    // the runner would read.
    const desktop = createDesktopService({ configuration: fileConfigurationPort, resourceAdapter: stubResourceAdapter() });
    const current = await desktop.snapshot(directory);
    for (const transport of AGENT_TRANSPORT_CHOICES) {
      const saved = await desktop.saveWorkflowConfig(directory, {
        ...current.workflow,
        codex: { ...current.workflow.codex, transport },
      });
      expect(saved.codex.transport).toBe(transport);
    }
  });

  it("lets the desktop save every authentication mode the core package declares", async () => {
    const desktop = createDesktopService({ configuration: fileConfigurationPort, resourceAdapter: stubResourceAdapter() });
    const current = await desktop.snapshot(directory);
    for (const auth of AGENT_AUTH_CHOICES) {
      const saved = await desktop.saveWorkflowConfig(directory, {
        ...current.workflow,
        codex: { ...current.workflow.codex, auth },
      });
      expect(saved.codex.auth).toBe(auth);
    }
  });
});
