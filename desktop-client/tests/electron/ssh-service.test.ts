import { describe, expect, it } from "vitest";
import { createSshService } from "../../electron/services/ssh-service";

const host = { id: "managed:build-box", alias: "build-box", hostname: "build.example.test", port: 22, source: "managed" as const, configPath: "~/.ssh/afk_hosts", status: "untrusted" as const };

function dependencies() {
  return {
    config: {
      listHosts: async () => ({ hosts: [host], diagnostics: [] }),
      upsertManagedHost: async () => host,
      removeManagedHost: async () => true,
    },
    commands: {
      resolve: async () => ({ hostname: host.hostname, port: host.port }),
      scanFingerprint: async () => ({ algorithm: "ED25519", value: "SHA256:one", hostname: host.hostname, port: host.port }),
      testBatch: async () => ({ ok: true, code: "ready" as const }),
      loadIdentity: async () => true,
      keygenArgs: () => [],
      deployArgs: () => [],
    },
    knownHosts: {
      isTrusted: async () => false,
      trust: async (fingerprint: typeof host & { algorithm: string; value: string }) => fingerprint,
      remove: async () => true,
    },
    audit: () => undefined,
  } as const;
}

describe("SSH service", () => {
  it("lists hosts with an explicit untrusted status", async () => {
    const service = createSshService(dependencies());
    const result = await service.listHosts();
    expect(result.hosts[0].status).toBe("untrusted");
  });

  it("trusts the scanned fingerprint before allowing a batch test", async () => {
    const deps = dependencies();
    const service = createSshService(deps);
    const fingerprint = await service.trustFingerprint({ hostId: host.id, fingerprint: { algorithm: "ED25519", value: "SHA256:one", hostname: host.hostname, port: host.port } });
    expect(fingerprint.value).toBe("SHA256:one");
    await expect(service.testHost(host.id)).rejects.toThrow("尚未信任");
  });

  it("marks a trusted host ready only after batch authentication succeeds", async () => {
    const deps = dependencies();
    deps.knownHosts.isTrusted = async () => true;
    const service = createSshService(deps);
    const result = await service.listHosts();
    expect(result.hosts[0].status).toBe("ready");
  });

  it("never includes raw command output in audit events", async () => {
    const events: unknown[] = [];
    const deps = { ...dependencies(), audit: (event: unknown) => events.push(event) };
    const service = createSshService(deps);
    await service.listHosts();
    expect(JSON.stringify(events)).not.toContain("private");
    expect(JSON.stringify(events)).not.toContain("password");
  });
});
