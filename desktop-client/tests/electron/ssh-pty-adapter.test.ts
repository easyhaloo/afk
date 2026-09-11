import { chmod, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSshPtyAdapter, ensureNodePtySpawnHelperExecutable } from "../../electron/adapters/ssh-pty-adapter";

function fakeProcess(pid: number) {
  let exitListener: ((event: { exitCode: number }) => void) | undefined;
  let dataListener: ((data: string) => void) | undefined;
  const writes: string[] = [];
  return {
    pid,
    onData: (listener: (data: string) => void) => { dataListener = listener; return { dispose: () => undefined }; },
    onExit: (listener: (event: { exitCode: number }) => void) => { exitListener = listener; return { dispose: () => undefined }; },
    write: (data: string) => { writes.push(data); },
    resize: () => undefined,
    kill: () => undefined,
    emit(data: string) { dataListener?.(data); },
    writes,
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

  it("connects a managed host by IP while retaining the display name in the session", () => {
    const calls: Array<[string, string[]]> = [];
    const adapter = createSshPtyAdapter({
      spawn: ((command, args) => { calls.push([command, args]); return fakeProcess(2); }) as never,
    });

    const session = adapter.connect("managed:stable-1", { hostname: "172.16.0.241", port: 22, user: "root" }, "kg演示");

    expect(calls).toEqual([["/usr/bin/ssh", ["-p", "22", "-l", "root", "--", "172.16.0.241"]]]);
    expect(session).toMatchObject({ alias: "kg演示", title: "SSH · kg演示" });
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

  it("sends a deployment password once when an ANSI SSH prompt arrives in chunks", () => {
    const child = fakeProcess(3);
    const output: string[] = [];
    const adapter = createSshPtyAdapter({
      spawn: (() => child) as never,
      onData: (_sessionId, data) => output.push(data),
    });

    adapter.deployKey("managed:demo", "demo", "remote-command", "stored-secret");
    child.emit("\u001b[1;32mdemo@server's pas");
    child.emit("sword:\u001b[0m ");
    child.emit("\r\npassword: ");

    expect(child.writes).toEqual(["stored-secret\n"]);
    expect(output).toEqual(["\u001b[1;32mdemo@server's pas", "sword:\u001b[0m ", "\r\npassword: "]);
  });

  it("does not auto-send for ordinary sessions or a second deployment prompt", () => {
    const ordinaryChild = fakeProcess(4);
    const deployChild = fakeProcess(5);
    const processes = [ordinaryChild, deployChild];
    const adapter = createSshPtyAdapter({ spawn: (() => processes.shift()!) as never });

    adapter.connect("system:demo", "demo");
    ordinaryChild.emit("demo output: password: not a prompt\n");
    adapter.deployKey("managed:demo", "demo", "remote-command", "stored-secret");
    deployChild.emit("password: ");
    deployChild.emit("\r\npassword: ");

    expect(ordinaryChild.writes).toEqual([]);
    expect(deployChild.writes).toEqual(["stored-secret\n"]);
  });

  it("clears the deployment password when the process exits or is closed", () => {
    const exitedChild = fakeProcess(6);
    const closedChild = fakeProcess(7);
    const processes = [exitedChild, closedChild];
    const adapter = createSshPtyAdapter({ spawn: (() => processes.shift()!) as never });

    adapter.deployKey("managed:exited", "exited", "remote-command", "exited-secret");
    exitedChild.exit(1);
    exitedChild.emit("password: ");
    const closedSession = adapter.deployKey("managed:closed", "closed", "remote-command", "closed-secret");
    adapter.close(closedSession.id);
    closedChild.emit("password: ");

    expect(exitedChild.writes).toEqual([]);
    expect(closedChild.writes).toEqual([]);
  });
});
