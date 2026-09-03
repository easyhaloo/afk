import { promises as fs } from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSshConfigAdapter } from "../../electron/adapters/ssh-config-adapter";

async function createHome(config: string, managed = "") {
  const home = await mkdtemp(path.join(tmpdir(), "afk-ssh-"));
  const sshDir = path.join(home, ".ssh");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(sshDir, { recursive: true, mode: 0o700 }));
  await writeFile(path.join(sshDir, "config"), config, { mode: 0o600 });
  if (managed) await writeFile(path.join(sshDir, "afk_hosts"), managed, { mode: 0o600 });
  return { home, sshDir };
}

function createInstrumentedFileSystem() {
  return {
    ...fs,
    stat: vi.fn(fs.stat),
    readFile: vi.fn(fs.readFile),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

type ControlledConfigFile = {
  content: string;
  exists: boolean;
  mtimeMs: number;
  size: number;
};

function createControlledFileSystem(files: Map<string, ControlledConfigFile>) {
  const fileSystem = createInstrumentedFileSystem();
  const missing = () => Object.assign(new Error("file missing"), { code: "ENOENT" });
  fileSystem.stat.mockImplementation(async (file) => {
    const state = files.get(file);
    if (!state?.exists) throw missing();
    return { mtimeMs: state.mtimeMs, size: state.size } as never;
  });
  fileSystem.readFile.mockImplementation(async (file) => {
    const state = files.get(file);
    if (!state?.exists) throw missing();
    return state.content;
  });
  return fileSystem;
}

describe("SSH config adapter", () => {
  it("reuses config reads when both file fingerprints are unchanged", async () => {
    const { home } = await createHome("Host demo\n  HostName demo.example.test\n", "Host managed\n  HostName managed.example.test\n");
    const fileSystem = createInstrumentedFileSystem();
    const adapter = createSshConfigAdapter({ home, fileSystem, exec: async () => ({ ok: true, stdout: "", stderr: "" }) });

    await adapter.listHosts();
    await adapter.listHosts();

    expect(fileSystem.readFile).toHaveBeenCalledTimes(2);
  });

  it("rereads only the config file whose mtime or size changed", async () => {
    const { home, sshDir } = await createHome("Host demo\n  HostName demo.example.test\n", "Host managed\n  HostName managed.example.test\n");
    const fileSystem = createInstrumentedFileSystem();
    const adapter = createSshConfigAdapter({ home, fileSystem, exec: async () => ({ ok: true, stdout: "", stderr: "" }) });

    await adapter.listHosts();
    await adapter.listHosts();
    await writeFile(path.join(sshDir, "afk_hosts"), "Host managed\n  HostName changed.example.test\n  User deploy\n", { mode: 0o600 });
    await adapter.listHosts();

    expect(fileSystem.readFile).toHaveBeenCalledTimes(3);
  });

  it("shares one in-flight listHosts request across concurrent callers", async () => {
    const { home } = await createHome("Host demo\n  HostName demo.example.test\n");
    const fileSystem = createInstrumentedFileSystem();
    const release = createDeferred<{ ok: boolean; stdout: string; stderr: string }>();
    let execCalls = 0;
    const adapter = createSshConfigAdapter({
      home,
      fileSystem,
      exec: async () => {
        execCalls += 1;
        return release.promise;
      },
    });

    const first = adapter.listHosts();
    const second = adapter.listHosts();
    release.resolve({ ok: true, stdout: "", stderr: "" });
    await Promise.all([first, second]);

    expect(fileSystem.readFile).toHaveBeenCalledTimes(1);
    expect(execCalls).toBe(1);
  });

  it("does not reuse cached hosts after a stat failure", async () => {
    const { home } = await createHome("Host demo\n  HostName demo.example.test\n");
    const fileSystem = createInstrumentedFileSystem();
    const configPath = path.join(home, ".ssh", "config");
    const originalStat = fileSystem.stat.getMockImplementation()!;
    const adapter = createSshConfigAdapter({ home, fileSystem, exec: async () => ({ ok: true, stdout: "", stderr: "" }) });

    await adapter.listHosts();
    fileSystem.stat.mockImplementation(async (file) => {
      if (file === configPath) throw new Error("stat failed");
      return originalStat(file);
    });
    fileSystem.readFile.mockImplementation(async (file, encoding) => {
      if (file === configPath) throw new Error("read failed");
      return fs.readFile(file, encoding);
    });

    const result = await adapter.listHosts();

    expect(result.hosts).toHaveLength(0);
    expect(fileSystem.readFile.mock.calls.filter(([file]) => file === configPath)).toHaveLength(2);
  });

  it("does not reuse cached hosts after a read failure", async () => {
    const { home } = await createHome("Host demo\n  HostName demo.example.test\n");
    const fileSystem = createInstrumentedFileSystem();
    const configPath = path.join(home, ".ssh", "config");
    const adapter = createSshConfigAdapter({ home, fileSystem, exec: async () => ({ ok: true, stdout: "", stderr: "" }) });

    await adapter.listHosts();
    await writeFile(configPath, "Host changed\n  HostName changed.example.test\n  User deploy\n", { mode: 0o600 });
    fileSystem.readFile.mockImplementationOnce(async (file, encoding) => {
      if (file === configPath) throw new Error("read failed");
      return fs.readFile(file, encoding);
    });

    const failed = await adapter.listHosts();
    const recovered = await adapter.listHosts();

    expect(failed.hosts).toHaveLength(0);
    expect(recovered.hosts.map((host) => host.alias)).toEqual(["changed"]);
    expect(fileSystem.readFile).toHaveBeenCalledTimes(3);
  });

  it("invalidates the cache after a successful managed host upsert", async () => {
    const { home } = await createHome("Host demo\n  HostName demo.example.test\n");
    const fileSystem = createInstrumentedFileSystem();
    fileSystem.stat.mockResolvedValue({ mtimeMs: 1, size: 1 } as never);
    const adapter = createSshConfigAdapter({ home, fileSystem, exec: async () => ({ ok: true, stdout: "", stderr: "" }) });

    await adapter.listHosts();
    await adapter.upsertManagedHost({ alias: "managed", hostname: "managed.example.test" });
    const readsAfterUpsert = fileSystem.readFile.mock.calls.length;
    const result = await adapter.listHosts();

    expect(result.hosts.map((host) => host.alias)).toEqual(["demo", "managed"]);
    expect(fileSystem.readFile).toHaveBeenCalledTimes(readsAfterUpsert);
  });

  it("invalidates the cache after a successful managed host removal", async () => {
    const { home } = await createHome("Host demo\n  HostName demo.example.test\n", "Host managed\n  HostName managed.example.test\n");
    const fileSystem = createInstrumentedFileSystem();
    fileSystem.stat.mockResolvedValue({ mtimeMs: 1, size: 1 } as never);
    const adapter = createSshConfigAdapter({ home, fileSystem, exec: async () => ({ ok: true, stdout: "", stderr: "" }) });

    await adapter.listHosts();
    await adapter.removeManagedHost("managed:managed");
    const result = await adapter.listHosts();

    expect(result.hosts.map((host) => host.alias)).toEqual(["demo"]);
  });

  it("returns current empty diagnostics after deletion and reads a rebuilt config", async () => {
    const { home } = await createHome("Host demo\n  StrictHostKeyChecking no\n");
    const configPath = path.join(home, ".ssh", "config");
    const files = new Map<string, ControlledConfigFile>([
      [configPath, { content: "Host demo\n  StrictHostKeyChecking no\n", exists: true, mtimeMs: 1, size: 10 }],
    ]);
    const fileSystem = createControlledFileSystem(files);
    const adapter = createSshConfigAdapter({ home, fileSystem, exec: async () => ({ ok: true, stdout: "", stderr: "" }) });

    const initial = await adapter.listHosts();
    files.get(configPath)!.exists = false;
    const deleted = await adapter.listHosts();
    files.set(configPath, { content: "Host rebuilt\n  HostName rebuilt.example.test\n", exists: true, mtimeMs: 2, size: 10 });
    const rebuilt = await adapter.listHosts();

    expect(initial.hosts.map((host) => host.alias)).toEqual(["demo"]);
    expect(initial.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ssh.host-key-checking-disabled", hostAlias: "demo" }),
    ]));
    expect(deleted.hosts).toEqual([]);
    expect(deleted.diagnostics).toEqual([]);
    expect(rebuilt.hosts).toEqual([expect.objectContaining({ alias: "rebuilt", hostname: "rebuilt.example.test" })]);
    expect(rebuilt.diagnostics).toEqual([]);
  });

  it.each(["mtimeMs", "size"] as const)("invalidates the cache when only %s changes", async (changedField) => {
    const { home } = await createHome("Host original\n  HostName original.example.test\n");
    const configPath = path.join(home, ".ssh", "config");
    const files = new Map<string, ControlledConfigFile>([
      [configPath, { content: "Host original\n  HostName original.example.test\n", exists: true, mtimeMs: 1, size: 10 }],
    ]);
    const fileSystem = createControlledFileSystem(files);
    const adapter = createSshConfigAdapter({ home, fileSystem, exec: async () => ({ ok: true, stdout: "", stderr: "" }) });

    await adapter.listHosts();
    await adapter.listHosts();
    files.set(configPath, {
      content: "Host changed\n  HostName changed.example.test\n",
      exists: true,
      mtimeMs: changedField === "mtimeMs" ? 2 : 1,
      size: changedField === "size" ? 11 : 10,
    });
    const result = await adapter.listHosts();

    expect(result.hosts).toEqual([expect.objectContaining({ alias: "changed", hostname: "changed.example.test" })]);
    expect(fileSystem.readFile.mock.calls.filter(([file]) => file === configPath)).toHaveLength(2);
  });

  it("keeps Include parsing and diagnostics consistent on a cache hit", async () => {
    const { home } = await createHome("Host demo\n  Include ~/.ssh/afk_hosts\n  StrictHostKeyChecking no\n", "Host managed\n  HostName managed.example.test\n");
    const configPath = path.join(home, ".ssh", "config");
    const managedPath = path.join(home, ".ssh", "afk_hosts");
    const files = new Map<string, ControlledConfigFile>([
      [configPath, { content: "Host demo\n  Include ~/.ssh/afk_hosts\n  StrictHostKeyChecking no\n", exists: true, mtimeMs: 1, size: 10 }],
      [managedPath, { content: "Host managed\n  HostName managed.example.test\n", exists: true, mtimeMs: 1, size: 10 }],
    ]);
    const fileSystem = createControlledFileSystem(files);
    const adapter = createSshConfigAdapter({ home, fileSystem, exec: async () => ({ ok: true, stdout: "", stderr: "" }) });

    const first = await adapter.listHosts();
    const second = await adapter.listHosts();

    expect(second).toEqual(first);
    expect(second.hosts.map((host) => host.alias)).toEqual(["demo", "managed"]);
    expect(second.diagnostics).toEqual([
      expect.objectContaining({ code: "ssh.host-key-checking-disabled", hostAlias: "demo" }),
    ]);
    expect(fileSystem.readFile.mock.calls.filter(([file]) => file === configPath)).toHaveLength(1);
    expect(fileSystem.readFile.mock.calls.filter(([file]) => file === managedPath)).toHaveLength(1);
  });

  it.each([
    ["StrictHostKeyChecking", "no"],
    ["stricthostkeychecking", "off"],
    ["STRICTHOSTKEYCHECKING", "NO"],
    ["StrictHostKeyChecking", "OFF"],
  ])("warns when %s is %s", async (directive, value) => {
    const { home } = await createHome(`Host demo\n  ${directive} ${value}\n`);
    const adapter = createSshConfigAdapter({ home, exec: async () => ({ ok: true, stdout: "", stderr: "" }) });

    const result = await adapter.listHosts();

    expect(result.diagnostics).toEqual(expect.arrayContaining([
      {
        code: "ssh.host-key-checking-disabled",
        severity: "warning",
        message: "Host demo 已关闭 SSH 主机密钥严格校验",
        path: "~/.ssh/config",
        hostAlias: "demo",
      },
    ]));
  });

  it.each([
    ["StrictHostKeyChecking=off", "Host demo 已关闭 SSH 主机密钥严格校验"],
    ["StrictHostKeyChecking=no # reason", "Host demo 已关闭 SSH 主机密钥严格校验"],
    ["StrictHostKeyChecking 'OFF' # reason", "Host demo 已关闭 SSH 主机密钥严格校验"],
  ])("warns for normalized host-key safety directive %s", async (directive, message) => {
    const { home } = await createHome(`Host demo\n  ${directive}\n`);
    const adapter = createSshConfigAdapter({ home, exec: async () => ({ ok: true, stdout: "", stderr: "" }) });

    const result = await adapter.listHosts();

    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ssh.host-key-checking-disabled", message, hostAlias: "demo", path: "~/.ssh/config" }),
    ]));
    expect(result.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ssh.malformed-directive" }),
    ]));
  });

  it.each(["yes", "ask", "accept-new"])('does not warn when StrictHostKeyChecking is "%s"', async (value) => {
    const { home } = await createHome(`Host demo\n  StrictHostKeyChecking ${value}\n`);
    const adapter = createSshConfigAdapter({ home, exec: async () => ({ ok: true, stdout: "", stderr: "" }) });

    const result = await adapter.listHosts();

    expect(result.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ssh.host-key-checking-disabled" }),
    ]));
  });

  it.each([
    ["UserKnownHostsFile", "none"],
    ["userknownhostsfile", "/dev/null"],
    ["UserKnownHostsFile", "/dev/null # reason"],
    ["USERKNOWNHOSTSFILE", "~/.ssh/known_hosts /dev/null ~/.ssh/known_hosts2"],
  ])("warns when %s disables known hosts with %s", async (directive, value) => {
    const { home } = await createHome(`Host demo\n  ${directive} ${value}\n`);
    const adapter = createSshConfigAdapter({ home, exec: async () => ({ ok: true, stdout: "", stderr: "" }) });

    const result = await adapter.listHosts();

    expect(result.diagnostics).toEqual(expect.arrayContaining([
      {
        code: "ssh.known-hosts-disabled",
        severity: "warning",
        message: "Host demo 已禁用用户 known_hosts 文件",
        path: "~/.ssh/config",
        hostAlias: "demo",
      },
    ]));
  });

  it.each(["/dev/null#safe", "none#backup"])("does not warn when UserKnownHostsFile is %s", async (value) => {
    const { home } = await createHome(`Host demo\n  UserKnownHostsFile ${value}\n`);
    const adapter = createSshConfigAdapter({ home, exec: async () => ({ ok: true, stdout: "", stderr: "" }) });

    const result = await adapter.listHosts();

    expect(result.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ssh.known-hosts-disabled" }),
    ]));
  });

  it.each(['""#safe /dev/null', "''#safe /dev/null"])("warns when an empty quoted token precedes %s", async (value) => {
    const { home } = await createHome(`Host demo\n  UserKnownHostsFile ${value}\n`);
    const adapter = createSshConfigAdapter({ home, exec: async () => ({ ok: true, stdout: "", stderr: "" }) });

    const result = await adapter.listHosts();

    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "ssh.known-hosts-disabled",
        message: "Host demo 已禁用用户 known_hosts 文件",
        hostAlias: "demo",
        path: "~/.ssh/config",
      }),
    ]));
  });

  it('warns when UserKnownHostsFile is quoted "/dev/null"', async () => {
    const { home } = await createHome('Host demo\n  UserKnownHostsFile "/dev/null"\n');
    const adapter = createSshConfigAdapter({ home, exec: async () => ({ ok: true, stdout: "", stderr: "" }) });

    const result = await adapter.listHosts();

    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "ssh.known-hosts-disabled",
        message: "Host demo 已禁用用户 known_hosts 文件",
        hostAlias: "demo",
        path: "~/.ssh/config",
      }),
    ]));
  });

  it("warns when a quoted UserKnownHostsFile list contains /dev/null before a comment", async () => {
    const { home } = await createHome("Host demo\n  UserKnownHostsFile '~/.ssh/known_hosts' '/dev/null' # reason\n");
    const adapter = createSshConfigAdapter({ home, exec: async () => ({ ok: true, stdout: "", stderr: "" }) });

    const result = await adapter.listHosts();

    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "ssh.known-hosts-disabled",
        message: "Host demo 已禁用用户 known_hosts 文件",
        hostAlias: "demo",
        path: "~/.ssh/config",
      }),
    ]));
  });

  it("does not warn for a normal UserKnownHostsFile", async () => {
    const { home } = await createHome("Host demo\n  UserKnownHostsFile ~/.ssh/known_hosts\n");
    const adapter = createSshConfigAdapter({ home, exec: async () => ({ ok: true, stdout: "", stderr: "" }) });

    const result = await adapter.listHosts();

    expect(result.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ssh.known-hosts-disabled" }),
    ]));
  });

  it("does not warn for normal quoted UserKnownHostsFile paths", async () => {
    const { home } = await createHome("Host demo\n  UserKnownHostsFile '~/.ssh/known_hosts' \"~/.ssh/known_hosts2\" # reason\n");
    const adapter = createSshConfigAdapter({ home, exec: async () => ({ ok: true, stdout: "", stderr: "" }) });

    const result = await adapter.listHosts();

    expect(result.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ssh.known-hosts-disabled" }),
    ]));
  });

  it.each(
    [
      ["StrictHostKeyChecking", "yes", "no", "ssh.host-key-checking-disabled", 0],
      ["StrictHostKeyChecking", "no", "yes", "ssh.host-key-checking-disabled", 1],
      ["StrictHostKeyChecking", "no", "off", "ssh.host-key-checking-disabled", 1],
      ["UserKnownHostsFile", "~/.ssh/known_hosts", "/dev/null", "ssh.known-hosts-disabled", 0],
      ["UserKnownHostsFile", "/dev/null", "~/.ssh/known_hosts", "ssh.known-hosts-disabled", 1],
      ["UserKnownHostsFile", "none", "/dev/null", "ssh.known-hosts-disabled", 1],
    ] as Array<[string, string, string, string, number]>,
  )("uses only the first %s value when configured as %s then %s", async (directive, first, second, code, expectedCount) => {
    const { home } = await createHome(`Host demo\n  ${directive} ${first}\n  ${directive} ${second}\n`);
    const adapter = createSshConfigAdapter({ home, exec: async () => ({ ok: true, stdout: "", stderr: "" }) });

    const result = await adapter.listHosts();

    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === code)).toHaveLength(expectedCount);
  });

  it.each([
    ['StrictHostKeyChecking "no', "ssh.host-key-checking-disabled"],
    ["UserKnownHostsFile '/dev/null", "ssh.known-hosts-disabled"],
  ])("defers incomplete safety value %s to ssh -G", async (directive, safetyCode) => {
    const { home } = await createHome(`Host demo\n  ${directive}\n`);
    const adapter = createSshConfigAdapter({
      home,
      exec: async () => ({ ok: false, stdout: "", stderr: "invalid configuration" }),
    });

    const result = await adapter.listHosts();

    expect(result.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: safetyCode }),
    ]));
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ssh.resolve-failed", hostAlias: "demo", path: "~/.ssh/config" }),
    ]));
  });

  it("defers structurally valid standard directives to OpenSSH", async () => {
    const { home } = await createHome(`Host demo
  HostName demo.example.test
  ServerAliveInterval 60
  ServerAliveCountMax 3
  ForwardAgent yes
  ControlMaster auto
`);
    const calls: Array<{ command: string; args: string[] }> = [];
    const adapter = createSshConfigAdapter({
      home,
      exec: async (command, args) => {
        calls.push({ command, args });
        return { ok: true, stdout: "", stderr: "" };
      },
    });

    const result = await adapter.listHosts();

    expect(calls).toEqual([{ command: "ssh", args: ["-G", "demo"] }]);
    expect(result.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ssh.unknown-directive" }),
    ]));
  });

  it("parses standard directives in equals form without losing spaces in values", async () => {
    const { home } = await createHome(`Host demo
  HostName=demo.example.test
  Port=2200
  User=admin
  IdentityFile="~/.ssh/key with spaces"
  ProxyJump=bastion
  Include=~/.ssh/extra_hosts
  ServerAliveInterval=60
`);
    const adapter = createSshConfigAdapter({ home, exec: async () => ({ ok: true, stdout: "", stderr: "" }) });

    const result = await adapter.listHosts();

    expect(result.hosts[0]).toMatchObject({
      alias: "demo",
      hostname: "demo.example.test",
      port: 2200,
      user: "admin",
      identityFile: '"~/.ssh/key with spaces"',
      proxyJump: "bastion",
    });
    expect(result.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ssh.unknown-directive" }),
    ]));
    expect(result.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ssh.malformed-directive" }),
    ]));
  });

  it("associates OpenSSH resolution failures with the affected host", async () => {
    const { home } = await createHome("Host demo\n  HostName demo.example.test\n  ServerAliveInterval 60\n");
    const adapter = createSshConfigAdapter({
      home,
      exec: async () => ({ ok: false, stdout: "", stderr: "Bad configuration option" }),
    });

    const result = await adapter.listHosts();

    const resolveFailures = result.diagnostics.filter((diagnostic) => diagnostic.code === "ssh.resolve-failed");
    expect(resolveFailures).toEqual([
      expect.objectContaining({ code: "ssh.resolve-failed", hostAlias: "demo" }),
    ]);
  });

  it("lists concrete system hosts and managed hosts while ignoring wildcards", async () => {
    const { home } = await createHome("Host *\n  ServerAliveInterval 30\n\nHost system-box\n  HostName system.example.test\n  User admin\n\nInclude ~/.ssh/afk_hosts\n", "Host managed-box\n  HostName managed.example.test\n  Port 2200\n");
    const adapter = createSshConfigAdapter({ home, exec: async () => ({ ok: true, stdout: "", stderr: "" }) });
    const result = await adapter.listHosts();
    expect(result.hosts.map((host) => host.alias)).toEqual(["system-box", "managed-box"]);
    expect(result.hosts[0].source).toBe("system");
    expect(result.hosts[1]).toMatchObject({ source: "managed", hostname: "managed.example.test", port: 2200 });
  });

  it("writes one managed host and keeps SSH files private", async () => {
    const { home, sshDir } = await createHome("Host existing\n  HostName existing.example.test\n");
    const adapter = createSshConfigAdapter({ home, exec: async () => ({ ok: true, stdout: "", stderr: "" }) });
    await adapter.upsertManagedHost({ alias: "new-box", hostname: "new.example.test", user: "deploy" });
    const config = await readFile(path.join(sshDir, "config"), "utf8");
    const managed = await readFile(path.join(sshDir, "afk_hosts"), "utf8");
    expect(config.match(/Include ~\/\.ssh\/afk_hosts/g)).toHaveLength(1);
    expect(managed).toContain("Host new-box");
    expect((await stat(path.join(sshDir, "afk_hosts"))).mode & 0o777).toBe(0o600);
  });

  it("preserves host context for parsing diagnostics", async () => {
    const { home } = await createHome("Host broken\n  UnknownDirective\n  ServerAliveInterval 30\n\nHost *\n  ServerAliveInterval 30\n");
    const adapter = createSshConfigAdapter({ home, exec: async () => ({ ok: true, stdout: "", stderr: "" }) });
    const result = await adapter.listHosts();
    expect(result.hosts).toHaveLength(1);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ssh.malformed-directive", hostAlias: "broken" }),
    ]));
    expect(result.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ssh.unknown-directive" }),
    ]));
    const nonConcreteHostDiagnostic = result.diagnostics.find((item) => item.code === "ssh.non-concrete-host");
    expect(nonConcreteHostDiagnostic).toBeDefined();
    expect(nonConcreteHostDiagnostic).not.toHaveProperty("hostAlias");
  });
});
