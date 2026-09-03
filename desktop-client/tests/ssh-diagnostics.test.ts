import { describe, expect, it } from "vitest";
import { groupSshDiagnostics } from "../src/features/ssh/ssh-diagnostics";
import type { SshDiagnostic } from "../shared/ssh-contract";

describe("SSH diagnostic grouping", () => {
  it("merges host-specific diagnostics and normalizes the message", () => {
    const grouped = groupSshDiagnostics([
      { code: "ssh.unknown-directive", severity: "warning", message: "Host demo 包含未识别配置项", path: "~/.ssh/config", hostAlias: "demo" },
      { code: "ssh.unknown-directive", severity: "warning", message: "Host prod 包含未识别配置项", path: "~/.ssh/config", hostAlias: "prod" },
      { code: "ssh.unknown-directive", severity: "warning", message: "Host demo 包含未识别配置项", path: "~/.ssh/config", hostAlias: "demo" },
    ]);

    expect(grouped).toEqual([
      {
        code: "ssh.unknown-directive",
        severity: "warning",
        message: "包含未识别配置项",
        path: "~/.ssh/config",
        count: 3,
        hostAliases: ["demo", "prod"],
      },
    ]);
  });

  it("keeps diagnostics separate when their path, severity, or code differs", () => {
    const diagnostic: SshDiagnostic = {
      code: "ssh.unknown-directive",
      severity: "warning",
      message: "Host demo 包含未识别配置项",
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
      expect.objectContaining({ code: "ssh.unknown-directive", severity: "warning", path: "~/.ssh/config", count: 1 }),
      expect.objectContaining({ code: "ssh.unknown-directive", severity: "warning", path: "~/.ssh/afk_hosts", count: 1 }),
      expect.objectContaining({ code: "ssh.unknown-directive", severity: "error", path: "~/.ssh/config", count: 1 }),
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
