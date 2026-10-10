import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { exec } from "../../electron/adapters/process-executor";

describe("process executor", () => {
  it("preserves explicitly configured PATH precedence before fallback directories", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "afk-executor-path-"));
    try {
      const binary = path.join(directory, "node");
      await writeFile(binary, "#!/bin/sh\nprintf fixture-node");
      await chmod(binary, 0o755);
      vi.stubEnv("PATH", `${directory}${path.delimiter}${process.env.PATH ?? ""}`);
      await expect(exec("node", ["--version"])).resolves.toMatchObject({ ok: true, stdout: "fixture-node" });
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

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

  it("allows long-running callers to override timeout and output limits", async () => {
    const result = await exec(
      process.execPath,
      ["-e", "setTimeout(() => process.stdout.write('done'), 25)"],
      undefined,
      undefined,
      { timeoutMs: 1_000, maxBuffer: 10_000 },
    );

    expect(result).toMatchObject({ ok: true, stdout: "done" });
  });
});

describe("process executor stdin", () => {
  it("writes the input option to the subprocess stdin", async () => {
    const result = await exec(
      process.execPath,
      ["-e", "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => process.stdout.write(data.toUpperCase()))"],
      undefined,
      "hello stdin",
    );

    expect(result).toMatchObject({ ok: true, stdout: "HELLO STDIN" });
  });

  it("resolves ok:false instead of hanging when stdin-reading children exit non-zero", async () => {
    const result = await exec(process.execPath, ["-e", "process.exit(3)"]);

    expect(result.ok).toBe(false);
  });
});
