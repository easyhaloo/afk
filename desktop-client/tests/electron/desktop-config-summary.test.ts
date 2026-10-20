import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkflowConfig } from "../../electron/services/desktop-service.js";

describe("desktop workflow configuration summary", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it("shows what the runner will use, not a second reading of the file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "afk-desktop-config-"));
    await mkdir(path.join(root, ".afk"), { recursive: true });
    await writeFile(path.join(root, ".afk", "config.yml"), "agentDefault: codex\nmaxRetries: 5\n", "utf8");
    process.env.AFK_GOAL_BUDGET = "4242";

    const summary = await readWorkflowConfig(root);

    expect(summary.agentDefault).toBe("codex");
    expect(summary.maxRetries).toBe(5);
    // The runner reads the goal budget out of the environment; the summary
    // used to ignore it and show the default the runner would not use.
    expect(summary.goalBudget).toBe(4242);
  });
});
