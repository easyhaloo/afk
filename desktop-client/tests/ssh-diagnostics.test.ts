import { describe, expect, it } from "vitest";
import { groupSshDiagnostics } from "../src/features/ssh/ssh-diagnostics";
import type { SshDiagnostic } from "../shared/ssh-contract";

describe("SSH diagnostic grouping", () => {
  it("merges host-specific diagnostics and normalizes the message", () => {
    const grouped = groupSshDiagnostics([
      { code: "ssh.host-key-checking-disabled", severity: "warning", message: "Host prod 已关闭 SSH 主机密钥严格校验", path: "~/.ssh/config", hostAlias: "prod" },
      { code: "ssh.host-key-checking-disabled", severity: "warning", message: "Host demo 已关闭 SSH 主机密钥严格校验", path: "~/.ssh/config", hostAlias: "demo" },
      { code: "ssh.host-key-checking-disabled", severity: "warning", message: "Host prod 已关闭 SSH 主机密钥严格校验", path: "~/.ssh/config", hostAlias: "prod" },
    ]);

    expect(grouped).toEqual([
      {
        code: "ssh.host-key-checking-disabled",
        severity: "warning",
        message: "已关闭 SSH 主机密钥严格校验",
        path: "~/.ssh/config",
        count: 3,
        hostAliases: ["demo", "prod"],
      },
    ]);
  });

  it("keeps diagnostics separate when their path, severity, or code differs", () => {
    const diagnostic: SshDiagnostic = {
      code: "ssh.host-key-checking-disabled",
      severity: "warning",
      message: "Host demo 已关闭 SSH 主机密钥严格校验",
      path: "~/.ssh/config",
      hostAlias: "demo",
    };

    const grouped = groupSshDiagnostics([
      diagnostic,
      { ...diagnostic, path: "~/.ssh/afk_hosts", hostAlias: "managed" },
      { ...diagnostic, severity: "error", hostAlias: "error-host" },
      { ...diagnostic, code: "ssh.malformed-directive", hostAlias: "broken" },
    ]);

    expect(grouped).toEqual([
      expect.objectContaining({ code: "ssh.host-key-checking-disabled", severity: "warning", path: "~/.ssh/config", count: 1 }),
      expect.objectContaining({ code: "ssh.host-key-checking-disabled", severity: "warning", path: "~/.ssh/afk_hosts", count: 1 }),
      expect.objectContaining({ code: "ssh.host-key-checking-disabled", severity: "error", path: "~/.ssh/config", count: 1 }),
      expect.objectContaining({ code: "ssh.malformed-directive", severity: "warning", path: "~/.ssh/config", count: 1 }),
    ]);
  });

  it("retains and groups diagnostics without a Host alias", () => {
    const grouped = groupSshDiagnostics([
      { code: "ssh.non-concrete-host", severity: "info", message: "已忽略非具体 Host：*", path: "~/.ssh/config" },
      { code: "ssh.non-concrete-host", severity: "info", message: "已忽略非具体 Host：*", path: "~/.ssh/config" },
    ]);

    expect(grouped).toEqual([
      {
        code: "ssh.non-concrete-host",
        severity: "info",
        message: "已忽略非具体 Host：*",
        path: "~/.ssh/config",
        count: 2,
        hostAliases: [],
      },
    ]);
  });
});
