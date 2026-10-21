import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { inMemoryRuntimePorts } from '../support/runtime-ports.js';

/**
 * The platforms a work item can come from are a vocabulary with one
 * owner: the application package, where the identity grammar reads it.
 * The command that adopts an issue, the tracker factory and the desktop
 * client each had their own copy of the two platforms there are, and
 * the command refused a platform the grammar knew.
 *
 * This test grows the vocabulary the application package publishes and
 * then asks the command whether it grew with it. A command that keeps
 * its own copy refuses the new value, and that refusal is the defect.
 */
vi.mock("@afk/application", async importOriginal => {
  const original = await importOriginal<typeof import("@afk/application")>();
  const platforms = [...original.WORK_ITEM_PLATFORMS, "bitbucket"];
  return {
    ...original,
    WORK_ITEM_PLATFORMS: platforms,
    GLOBAL_WORK_ITEM_PLATFORMS: [...platforms, "all"],
    isWorkItemPlatform: (value: unknown) => platforms.includes(value as never),
  };
});

import { WORK_ITEM_PLATFORMS } from "@afk/application";
import { registerBacklogCommands } from "../../src/cli/commands/backlog";

vi.mock("@afk/infrastructure", async importOriginal => ({
  ...await importOriginal<typeof import("@afk/infrastructure")>(),
  createManagementProviders: vi.fn(async () => ({ backlog: {}, branches: {}, changes: {} })),
}));

function adoptCommand(): Command {
  const program = new Command().exitOverride();
  registerBacklogCommands(program, { ports: inMemoryRuntimePorts() });
  const backlog = program.commands.find(command => command.name() === "backlog");
  return backlog?.commands.find(command => command.name() === "adopt") as Command;
}

describe("The command answers with the platforms the application publishes", () => {
  it("names every platform the application declares in its help", () => {
    const help = adoptCommand().helpInformation();
    for (const value of WORK_ITEM_PLATFORMS) {
      expect(help).toContain(value);
    }
  });

  it("accepts every platform the application declares", async () => {
    for (const value of WORK_ITEM_PLATFORMS) {
      const program = new Command().exitOverride();
      registerBacklogCommands(program, { ports: inMemoryRuntimePorts() });
      let failure: unknown;
      try {
        await program.parseAsync(['node', 'afk', 'backlog', 'adopt', '--id', '42', '--project', 'acme/api', '--platform', value]);
      } catch (error) {
        failure = error;
      }
      // Commander's own validation is the command's answer to "which
      // platform is this": a platform the grammar knows and the command
      // does not is a platform a user cannot ask for. The run itself may
      // fail later - the mock provider has nothing to adopt.
      const message = failure instanceof Error ? failure.message : String(failure ?? '');
      expect(message).not.toMatch(/allowed choices|argument '.*' is invalid/i);
    }
  });
});
