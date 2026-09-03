import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createKnownHostsAdapter } from "../../electron/adapters/known-hosts-adapter";

describe("known_hosts adapter", () => {
  it("trusts only when the second scan matches the confirmed fingerprint", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "afk-known-hosts-"));
    let scans = 0;
    const adapter = createKnownHostsAdapter({
      home,
      scan: async () => { scans += 1; return scans === 1 ? "host ssh-ed25519 AAAAone" : "host ssh-ed25519 AAAAone"; },
      fingerprint: async () => ({ algorithm: "ED25519", value: "SHA256:one", hostname: "host", port: 22 }),
    });
    await adapter.trust({ algorithm: "ED25519", value: "SHA256:one", hostname: "host", port: 22 });
    expect(await readFile(path.join(home, ".ssh", "known_hosts"), "utf8")).toContain("host ssh-ed25519 AAAAone");
    expect(scans).toBe(2);
  });

  it("rejects a changed fingerprint before writing known_hosts", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "afk-known-hosts-"));
    const adapter = createKnownHostsAdapter({
      home,
      scan: async () => "host ssh-ed25519 AAAAtwo",
      fingerprint: async () => ({ algorithm: "ED25519", value: "SHA256:two", hostname: "host", port: 22 }),
    });
    await expect(adapter.trust({ algorithm: "ED25519", value: "SHA256:one", hostname: "host", port: 22 })).rejects.toThrow("SSH 主机指纹在确认期间发生变化");
  });
});
