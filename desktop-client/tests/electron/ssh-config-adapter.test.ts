import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSshConfigAdapter } from "../../electron/adapters/ssh-config-adapter";

async function createHome(config: string, managed = "") {
  const home = await mkdtemp(path.join(tmpdir(), "afk-ssh-"));
  const sshDir = path.join(home, ".ssh");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(sshDir, { recursive: true, mode: 0o700 }));
  await writeFile(path.join(sshDir, "config"), config, { mode: 0o600 });
  if (managed) await writeFile(path.join(sshDir, "afk_hosts"), managed, { mode: 0o600 });
  return { home, sshDir };
}

describe("SSH config adapter", () => {
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
