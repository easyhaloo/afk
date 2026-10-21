import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyError } from "@afk/application";
import { createBacklogService } from "../../electron/services/backlog-service";
import { BacklogServiceError } from "../../electron/services/backlog-error";
import type { BacklogItem } from "@afk/application";

/**
 * "What kind of failure was this?" is one question, and the use cases
 * answer it. The desktop used to spell the five codes out again and to
 * re-check the answer against that list, so a code the use cases added
 * was quietly turned into "unknown" on the way to the recovery UI.
 *
 * This test makes the use cases answer with a code the desktop's old
 * list did not hold, and asks the desktop what it reports.
 */
vi.mock("@afk/application", async importOriginal => {
  const original = await importOriginal<typeof import("@afk/application")>();
  return {
    ...original,
    classifyError: () => "timeout" as never,
  };
});

function stubItem(): BacklogItem {
  return {
    id: "1", title: "task", description: "demo",
    parentId: undefined, baseBacklogId: undefined, dependsOn: [],
    state: "ready", executionMode: "afk", tags: [],
    branchName: "afk/backlog-1", providerRef: "stub:1",
  };
}

describe("the desktop's error code", () => {
  it("is the code the use cases gave it", async () => {
    const provider = {
      get: vi.fn(async () => stubItem()),
      list: vi.fn(async () => { throw new Error("the provider fell over"); }),
      create: vi.fn(async () => stubItem()),
      addTag: vi.fn(async () => undefined),
      removeTag: vi.fn(async () => undefined),
      initialize: vi.fn(async () => undefined),
    };
    const service = createBacklogService({
      providers: async () => provider as never,
      resolveWorkspace: (input: string) => input,
    });

    const failure = await service.list("/workspace").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BacklogServiceError);
    // The code the use cases answered with reaches the desktop's
    // recovery UI, rather than being rewritten to a code the desktop
    // happens to know.
    expect((failure as BacklogServiceError).code).toBe(classifyError(new Error("x")));
  });

  it("is not spelled out again where the desktop renders it", () => {
    const contract = readFileSync(join(process.cwd(), "shared", "backlog-contract.ts"), "utf8");
    const service = readFileSync(join(process.cwd(), "electron", "services", "backlog-service.ts"), "utf8");

    // One list of codes: the use cases own it. A second list is a second
    // answer, and it is the one that decides what the desktop can show.
    expect(contract).not.toMatch(/export type BacklogErrorCode\s*=\s*\|/);
    expect(service).not.toMatch(/code === "auth"/);
  });
});
