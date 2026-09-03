import { chmod, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSshPtyAdapter, ensureNodePtySpawnHelperExecutable } from "../../electron/adapters/ssh-pty-adapter";

function fakeProcess(pid: number) {
  let exitListener: ((event: { exitCode: number }) => void) | undefined;
  return {
    pid,
    onData: () => ({ dispose: () => undefined }),
    onExit: (listener: (event: { exitCode: number }) => void) => { exitListener = listener; return { dispose: () => undefined }; },
    write: () => undefined,
    resize: () => undefined,
    kill: () => undefined,
    exit(code: number) { exitListener?.({ exitCode: code }); },
  };
}

describe("SSH PTY adapter", () => {
  it("repairs the macOS node-pty spawn helper executable bit", async () => {
    const packageRoot = await mkdtemp(path.join(tmpdir(), "afk-node-pty-"));
    const runtimeDirectory = path.join(packageRoot, "prebuilds", "darwin-arm64");
    await mkdir(runtimeDirectory, { recursive: true });
    await writeFile(path.join(runtimeDirectory, "pty.node"), "native");
    const helperPath = path.join(runtimeDirectory, "spawn-helper");
    await writeFile(helperPath, "helper");
    await chmod(helperPath, 0o644);

    expect(ensureNodePtySpawnHelperExecutable({ packageRoot, platform: "darwin", arch: "arm64" })).toBe(helperPath);
    expect((await stat(helperPath)).mode & 0o777).toBe(0o755);
  });

  it("prepares node-pty once before spawning terminal sessions", () => {
    const events: string[] = [];
    const adapter = createSshPtyAdapter({
      prepareSpawn: () => events.push("prepare"),
      spawn: (() => { events.push("spawn"); return fakeProcess(1); }) as never,
    });

    adapter.connect("system:demo", "demo");
    adapter.connect("system:second", "second");

    expect(events).toEqual(["prepare", "spawn", "spawn"]);
  });

  it("chains ssh-add after successful key generation", () => {
    const calls: Array<[string, string[]]> = [];
    const first = fakeProcess(1);
    const second = fakeProcess(2);
    const processes = [first, second];
    const adapter = createSshPtyAdapter({ spawn: ((command, args) => { calls.push([command, args]); return processes.shift()!; }) as never });
    adapter.generateKey("/Users/tester/.ssh/id_ed25519_afk");
    expect(calls[0]).toEqual(["/usr/bin/ssh-keygen", ["-t", "ed25519", "-f", "/Users/tester/.ssh/id_ed25519_afk", "-C", "afk-managed"]]);
    first.exit(0);
    expect(calls[1]).toEqual(["/usr/bin/ssh-add", ["--apple-use-keychain", "/Users/tester/.ssh/id_ed25519_afk"]]);
    expect(second.pid).toBe(2);
  });
});
