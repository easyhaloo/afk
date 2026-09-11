import { describe, expect, it } from "vitest";
import { sshHostStatusPriority, type SshHost } from "../../shared/ssh-contract";

describe("SSH shared contract", () => {
  it("keeps the safety ordering from invalid to ready", () => {
    expect(sshHostStatusPriority("invalid")).toBeLessThan(sshHostStatusPriority("ready"));
    expect(sshHostStatusPriority("identity-changed")).toBeLessThan(sshHostStatusPriority("untrusted"));
  });

  it("represents a managed host without secret material", () => {
    const host: SshHost = {
      id: "managed:build-box",
      alias: "build-box",
      hostname: "build.example.test",
      port: 22,
      user: "deploy",
      identityFile: "~/.ssh/id_ed25519_afk",
      source: "managed",
      configPath: "~/.ssh/afk_hosts",
      status: "untrusted",
    };
    expect(host).not.toHaveProperty("privateKey");
    expect(host).not.toHaveProperty("password");
  });
});
