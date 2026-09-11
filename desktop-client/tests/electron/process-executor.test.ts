import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exec } from "../../electron/adapters/process-executor";

describe("process executor", () => {
  it("propagates the subprocess working directory through PWD", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "afk-process-executor-"));
    try {
      const result = await exec(process.execPath, ["-e", "process.stdout.write(process.env.PWD || '')"], workspace);

      expect(result.ok).toBe(true);
      expect(result.stdout).toBe(workspace);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
