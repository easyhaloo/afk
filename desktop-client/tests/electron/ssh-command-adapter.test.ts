import { describe, expect, it } from "vitest";
import { createSshCommandAdapter } from "../../electron/adapters/ssh-command-adapter";

describe("OpenSSH command adapter", () => {
  it("passes structured arguments to ssh config resolution and batch testing", async () => {
    const calls: Array<[string, string[]]> = [];
    const adapter = createSshCommandAdapter({
      exec: async (command, args) => {
        calls.push([command, args]);
        return { ok: true, stdout: "hostname build.example.test\nuser deploy\nport 2222\n", stderr: "" };
      },
    });
    await adapter.resolve("build-box");
    await adapter.testBatch("build-box");
    expect(calls[0]).toEqual(["ssh", ["-G", "build-box"]]);
    expect(calls[1]).toEqual(["ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "build-box", "true"]]);
  });

  it("parses a SHA256 fingerprint without returning key material", async () => {
    const adapter = createSshCommandAdapter({
      exec: async () => ({ ok: true, stdout: "build.example.test ssh-ed25519 AAAAsecret\n", stderr: "" }),
    });
    const fingerprint = await adapter.scanFingerprint({ hostname: "build.example.test", port: 22 });
    expect(fingerprint).toMatchObject({ algorithm: "ED25519", value: "SHA256:OHLWq/W56Fd2CoG+J+rQByH3Kf289dFAB/MEwEr+nVw", hostname: "build.example.test", port: 22 });
    expect(fingerprint).not.toHaveProperty("key");
  });
});
