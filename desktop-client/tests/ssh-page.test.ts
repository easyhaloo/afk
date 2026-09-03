import { describe, expect, it } from "vitest";
import { filterSshHosts, sshDiagnosticTypeLabel } from "../src/features/ssh/SshHostsPage";
import type { SshHost } from "../shared/ssh-contract";

const hosts: SshHost[] = [
  { id: "system:prod", alias: "prod", hostname: "10.0.0.1", port: 22, source: "system", configPath: "~/.ssh/config", status: "ready" },
  { id: "managed:stage", alias: "stage", hostname: "staging.example.test", port: 2200, source: "managed", configPath: "~/.ssh/afk_hosts", status: "untrusted" },
];

describe("SSH host filtering", () => {
  it("combines query, source, and status without mutating the list", () => {
    expect(filterSshHosts(hosts, "staging", "managed", "untrusted")).toEqual([hosts[1]]);
    expect(hosts).toHaveLength(2);
  });
});

describe("SSH diagnostic type labels", () => {
  it("returns exact labels for safety, existing, and unknown diagnostic codes", () => {
    expect(sshDiagnosticTypeLabel("ssh.host-key-checking-disabled")).toBe("主机密钥校验已关闭");
    expect(sshDiagnosticTypeLabel("ssh.known-hosts-disabled")).toBe("known_hosts 已禁用");
    expect(sshDiagnosticTypeLabel("ssh.malformed-directive")).toBe("无法解析的配置行");
    expect(sshDiagnosticTypeLabel("ssh.unrecognized-code")).toBe("配置诊断");
  });
});
