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
      expect.objectContaining({ code: "ssh.unknown-directive", hostAlias: "broken" }),
    ]));
    const nonConcreteHostDiagnostic = result.diagnostics.find((item) => item.code === "ssh.non-concrete-host");
    expect(nonConcreteHostDiagnostic).toBeDefined();
    expect(nonConcreteHostDiagnostic).not.toHaveProperty("hostAlias");
  });
});
