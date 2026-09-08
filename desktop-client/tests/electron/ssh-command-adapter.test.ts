import { describe, expect, it } from "vitest";
import { createSshCommandAdapter } from "../../electron/adapters/ssh-command-adapter";

describe("OpenSSH command adapter", () => {
  it("builds SSH commands from a real host target instead of a display name", async () => {
    const calls: Array<[string, string[]]> = [];
    const adapter = createSshCommandAdapter({
      exec: async (command, args) => {
        calls.push([command, args]);
        return { ok: true, stdout: "", stderr: "" };
      },
    });

    await adapter.testBatch({ hostname: "172.16.0.241", port: 22, user: "root", identityFile: "~/.ssh/id_ed25519", proxyJump: "fangcloud-jumpserver" });

    expect(calls).toEqual([["ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-p", "22", "-l", "root", "-i", "~/.ssh/id_ed25519", "-J", "fangcloud-jumpserver", "--", "172.16.0.241", "true"]]]);
  });

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

  it("builds a parameterized scp upload for a direct target", async () => {
    const calls: Array<[string, string[]]> = [];
    const adapter = createSshCommandAdapter({
      exec: async (command, args) => {
        calls.push([command, args]);
        return { ok: true, stdout: "", stderr: "" };
      },
    });

    await adapter.upload("/tmp/release notes.txt", { hostname: "build.example.test", port: 2222, user: "deploy", identityFile: "/Users/test/.ssh/id_ed25519", proxyJump: "bastion" }, "/srv/releases/");

    expect(calls).toEqual([[
      "scp",
      ["-P", "2222", "-i", "/Users/test/.ssh/id_ed25519", "-J", "bastion", "--", "/tmp/release notes.txt", "deploy@build.example.test:/srv/releases/"],
    ]]);
  });

  it("uploads through an OpenSSH alias without treating the alias as a shell command", async () => {
    const calls: Array<[string, string[]]> = [];
    const adapter = createSshCommandAdapter({
      exec: async (command, args) => {
        calls.push([command, args]);
        return { ok: true, stdout: "", stderr: "" };
      },
    });

    await adapter.upload("/tmp/archive.tar.gz", "build-box", "~/uploads/");

    expect(calls).toEqual([["scp", ["--", "/tmp/archive.tar.gz", "build-box:~/uploads/"]]]);
  });
});
