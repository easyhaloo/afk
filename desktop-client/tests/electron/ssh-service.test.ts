import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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
    pty: {
      connect: () => ({ id: "session-1", hostId: host.id, alias: host.alias, kind: "ssh" as const, title: host.alias, state: "opening" as const }),
      generateKey: () => ({ id: "session-key", hostId: "local", alias: "keygen", kind: "keygen" as const, title: "keygen", state: "opening" as const }),
      deployKey: (_hostId: string, _alias: string, _remoteCommand: string, _password?: string) => ({ id: "session-deploy", hostId: host.id, alias: host.alias, kind: "deploy" as const, title: host.alias, state: "opening" as const }),
      input: () => true,
      resize: () => true,
      close: () => true,
    },
    credentialService: {
      has: async () => false,
      get: async () => undefined as string | undefined,
      set: async () => true,
      remove: async () => true,
    },
    externalTerminal: {
      open: async () => "iTerm2" as const,
    },
    audit: () => undefined,
  } as const;
}

describe("SSH service", () => {
  it.each([
    [{ unexpected: true }, "unknown option"],
    [["forceRefresh"], "array options"],
    [null, "null options"],
    ["options", "string options"],
    [42, "number options"],
    [true, "boolean options"],
    [{ forceRefresh: "true" }, "non-boolean forceRefresh"],
  ])("rejects invalid list options: %s", (options, _caseName) => {
    const service = createSshService(dependencies());

    expect(() => service.listHosts(options as never)).toThrow("SSH 列表参数无效");
  });

  it("lists hosts with an explicit untrusted status", async () => {
    const service = createSshService(dependencies());
    const result = await service.listHosts();
    expect(result.hosts[0].status).toBe("untrusted");
  });

  it("reads the host credential after trust checks and passes it only to deploy PTY", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "afk-ssh-service-"));
    await mkdir(path.join(home, ".ssh"), { recursive: true });
    await writeFile(path.join(home, ".ssh", "id_ed25519_afk.pub"), "ssh-ed25519 AAAATEST afk");
    const deps = dependencies();
    const calls: string[] = [];
    let receivedPassword: string | undefined;
    deps.home = home;
    deps.knownHosts.isTrusted = async () => {
      calls.push("trusted");
      return true;
    };
    deps.commands.resolve = async () => ({ hostname: "resolved.example.test", port: 2222, user: "deploy" });
    deps.credentialService.get = async (hostId, target) => {
      calls.push(`credential:${hostId}:${target.hostname}:${target.port}:${target.user}`);
      return "stored-secret";
    };
    deps.pty.deployKey = (_hostId, _alias, _remoteCommand, password) => {
      receivedPassword = password;
      calls.push("deploy");
      return { id: "session-deploy", hostId: host.id, alias: host.alias, kind: "deploy", title: host.alias, state: "opening" };
    };
    const service = createSshService(deps);

    await service.deployKey(host.id);

    expect(calls).toEqual(["trusted", `credential:${host.id}:resolved.example.test:2222:deploy`, "deploy"]);
    expect(receivedPassword).toBe("stored-secret");
  });

  it("resolves the current target for credential status and save, but not removal", async () => {
    const deps = dependencies();
    const calls: unknown[][] = [];
    let resolveCalls = 0;
    deps.commands.resolve = async () => {
      resolveCalls += 1;
      return { hostname: "resolved.example.test", port: 2222, user: "deploy" };
    };
    deps.credentialService.has = async (...args) => { calls.push(["has", ...args]); return true; };
    deps.credentialService.set = async (...args) => { calls.push(["set", ...args]); return true; };
    deps.credentialService.remove = async (...args) => { calls.push(["remove", ...args]); return true; };
    const service = createSshService(deps);

    await expect(service.hasCredential(host.id)).resolves.toBe(true);
    await expect(service.setCredential(host.id, "stored-secret")).resolves.toBe(true);
    await expect(service.removeCredential(host.id)).resolves.toBe(true);

    const target = { hostname: "resolved.example.test", port: 2222, user: "deploy" };
    expect(calls).toEqual([
      ["has", host.id, target],
      ["set", host.id, "stored-secret", target],
      ["remove", host.id],
    ]);
    expect(resolveCalls).toBe(2);
  });

  it("removes a credential even when the host target cannot be resolved", async () => {
    const deps = dependencies();
    deps.commands.resolve = async () => {
      throw new Error("ssh config resolve failed");
    };
    const removeCredential = vi.fn().mockResolvedValue(true);
    deps.credentialService.remove = removeCredential;
    const service = createSshService(deps);

    await expect(service.removeCredential(host.id)).resolves.toBe(true);

    expect(removeCredential).toHaveBeenCalledWith(host.id);
  });

  it("keeps deployment interactive when a saved alias now resolves to another target", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "afk-ssh-service-"));
    await mkdir(path.join(home, ".ssh"), { recursive: true });
    await writeFile(path.join(home, ".ssh", "id_ed25519_afk.pub"), "ssh-ed25519 AAAATEST afk");
    const deps = dependencies();
    let receivedPassword: string | undefined = "unexpected";
    deps.home = home;
    deps.commands.resolve = async () => ({ hostname: "replacement.example.test", port: 2200, user: "ubuntu" });
    deps.knownHosts.isTrusted = async () => true;
    deps.credentialService.get = async (_hostId, target) => target.hostname === host.hostname ? "old-secret" : undefined;
    deps.pty.deployKey = (_hostId, _alias, _remoteCommand, password) => {
      receivedPassword = password;
      return { id: "session-deploy", hostId: host.id, alias: host.alias, kind: "deploy", title: host.alias, state: "opening" };
    };
    const service = createSshService(deps);

    await service.deployKey(host.id);

    expect(receivedPassword).toBeUndefined();
  });

  it("keeps deployment interactive when no host credential is stored", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "afk-ssh-service-"));
    await mkdir(path.join(home, ".ssh"), { recursive: true });
    await writeFile(path.join(home, ".ssh", "id_ed25519_afk.pub"), "ssh-ed25519 AAAATEST afk");
    const deps = dependencies();
    let receivedPassword: string | undefined = "unexpected";
    deps.home = home;
    deps.knownHosts.isTrusted = async () => true;
    deps.pty.deployKey = (_hostId, _alias, _remoteCommand, password) => {
      receivedPassword = password;
      return { id: "session-deploy", hostId: host.id, alias: host.alias, kind: "deploy", title: host.alias, state: "opening" };
    };
    const service = createSshService(deps);

    await service.deployKey(host.id);

    expect(receivedPassword).toBeUndefined();
  });

  it("keeps deployment interactive when credential service is unavailable", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "afk-ssh-service-"));
    await mkdir(path.join(home, ".ssh"), { recursive: true });
    await writeFile(path.join(home, ".ssh", "id_ed25519_afk.pub"), "ssh-ed25519 AAAATEST afk");
    const deps = dependencies();
    let receivedPassword: string | undefined = "unexpected";
    deps.home = home;
    deps.credentialService = undefined;
    deps.knownHosts.isTrusted = async () => true;
    deps.pty.deployKey = (_hostId, _alias, _remoteCommand, password) => {
      receivedPassword = password;
      return { id: "session-deploy", hostId: host.id, alias: host.alias, kind: "deploy", title: host.alias, state: "opening" };
    };
    const service = createSshService(deps);

    await service.deployKey(host.id);

    expect(receivedPassword).toBeUndefined();
  });

  it("does not read or pass a credential before the known_hosts check", async () => {
    const deps = dependencies();
    let credentialReads = 0;
    let deployCalls = 0;
    deps.credentialService.get = async () => {
      credentialReads += 1;
      return "stored-secret";
    };
    deps.pty.deployKey = () => {
      deployCalls += 1;
      return { id: "session-deploy", hostId: host.id, alias: host.alias, kind: "deploy", title: host.alias, state: "opening" };
    };
    const service = createSshService(deps);

    await expect(service.deployKey(host.id)).rejects.toThrow("尚未信任");

    expect(credentialReads).toBe(0);
    expect(deployCalls).toBe(0);
  });

  it("reuses host status within the cache TTL", async () => {
    const deps = dependencies();
    let configCalls = 0;
    let resolveCalls = 0;
    let scanCalls = 0;
    let testCalls = 0;
    deps.knownHosts.isTrusted = async () => true;
    deps.config.listHosts = async () => {
      configCalls += 1;
      return { hosts: [host], diagnostics: [] };
    };
    deps.commands.resolve = async () => {
      resolveCalls += 1;
      return { hostname: host.hostname, port: host.port };
    };
    deps.commands.scanFingerprint = async () => {
      scanCalls += 1;
      return { algorithm: "ED25519", value: "SHA256:one", hostname: host.hostname, port: host.port };
    };
    deps.commands.testBatch = async () => {
      testCalls += 1;
      return { ok: true, code: "ready" as const };
    };
    const service = createSshService(deps);

    await service.listHosts();
    await service.listHosts();

    expect(resolveCalls).toBe(1);
    expect(scanCalls).toBe(1);
    expect(testCalls).toBe(1);
    expect(configCalls).toBe(2);
  });

  it("expires host status after ten seconds", async () => {
    vi.useFakeTimers();
    try {
      const deps = dependencies();
      let resolveCalls = 0;
      deps.knownHosts.isTrusted = async () => true;
      deps.commands.resolve = async () => {
        resolveCalls += 1;
        return { hostname: host.hostname, port: host.port };
      };
      const service = createSshService(deps);

      await service.listHosts();
      vi.advanceTimersByTime(10_001);
      await service.listHosts();

      expect(resolveCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares one in-flight list request across concurrent callers", async () => {
    const deps = dependencies();
    let resolveCalls = 0;
    let releaseResolve!: () => void;
    const resolvePending = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    deps.commands.resolve = async () => {
      resolveCalls += 1;
      await resolvePending;
      return { hostname: host.hostname, port: host.port };
    };
    const service = createSshService(deps);

    const first = service.listHosts();
    const second = service.listHosts();

    expect(first).toBe(second);
    releaseResolve();
    await Promise.all([first, second]);
    expect(resolveCalls).toBe(1);
  });

  it("forceRefresh skips the cached host status", async () => {
    const deps = dependencies();
    let resolveCalls = 0;
    let scanCalls = 0;
    let testCalls = 0;
    deps.knownHosts.isTrusted = async () => true;
    deps.commands.resolve = async () => {
      resolveCalls += 1;
      return { hostname: host.hostname, port: host.port };
    };
    deps.commands.scanFingerprint = async () => {
      scanCalls += 1;
      return { algorithm: "ED25519", value: "SHA256:one", hostname: host.hostname, port: host.port };
    };
    deps.commands.testBatch = async () => {
      testCalls += 1;
      return { ok: true, code: "ready" as const };
    };
    const service = createSshService(deps);

    await service.listHosts();
    await service.listHosts({ forceRefresh: true });

    expect(resolveCalls).toBe(2);
    expect(scanCalls).toBe(2);
    expect(testCalls).toBe(2);
  });

  it("does not cache a rejected list request", async () => {
    const deps = dependencies();
    let attempts = 0;
    deps.config.listHosts = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary config failure");
      return { hosts: [host], diagnostics: [] };
    };
    const service = createSshService(deps);

    await expect(service.listHosts()).rejects.toThrow("temporary config failure");
    await expect(service.listHosts()).resolves.toMatchObject({ hosts: [host] });
    expect(attempts).toBe(2);
  });

  it("invalidates the related status after trusting a fingerprint", async () => {
    const deps = dependencies();
    let trusted = false;
    let resolveCalls = 0;
    deps.knownHosts.isTrusted = async () => trusted;
    deps.knownHosts.trust = async (fingerprint) => {
      trusted = true;
      return fingerprint;
    };
    deps.commands.resolve = async () => {
      resolveCalls += 1;
      return { hostname: host.hostname, port: host.port };
    };
    const service = createSshService(deps);

    await service.listHosts();
    await service.trustFingerprint({ hostId: host.id, fingerprint: { algorithm: "ED25519", value: "SHA256:one", hostname: host.hostname, port: host.port } });
    const result = await service.listHosts();

    expect(result.hosts[0].status).toBe("ready");
    expect(resolveCalls).toBe(2);
  });

  it("invalidates the list after removing a managed host", async () => {
    const deps = dependencies();
    let hosts = [host];
    deps.config.listHosts = async () => ({ hosts, diagnostics: [] });
    deps.config.removeManagedHost = async () => {
      hosts = [];
      return true;
    };
    const service = createSshService(deps);

    await service.listHosts();
    await service.removeHost(host.id);

    await expect(service.listHosts()).resolves.toMatchObject({ hosts: [] });
  });

  it("removes the managed host credential before deleting the host", async () => {
    const deps = dependencies();
    const credentialPresent = new Set([host.id]);
    const calls: string[] = [];
    deps.credentialService.remove = async (hostId) => {
      calls.push(`credential:${hostId}`);
      credentialPresent.delete(hostId);
      return true;
    };
    deps.config.removeManagedHost = async (hostId) => {
      calls.push(`host:${hostId}`);
      return true;
    };
    const service = createSshService(deps);

    await expect(service.removeHost(host.id)).resolves.toBe(true);
    expect(calls).toEqual([`credential:${host.id}`, `host:${host.id}`]);
    expect(credentialPresent.has(host.id)).toBe(false);
  });

  it("does not delete the managed host when credential cleanup fails", async () => {
    const deps = dependencies();
    const cleanupError = new Error("credential cleanup failed");
    const credentialPresent = new Set([host.id]);
    let removeHostCalls = 0;
    deps.credentialService.remove = async () => {
      throw cleanupError;
    };
    deps.config.removeManagedHost = async () => {
      removeHostCalls += 1;
      return true;
    };
    const service = createSshService(deps);

    await expect(service.removeHost(host.id)).rejects.toBe(cleanupError);
    expect(removeHostCalls).toBe(0);
    expect(credentialPresent.has(host.id)).toBe(true);
  });

  it("deletes the managed host when no credential exists", async () => {
    const deps = dependencies();
    const calls: string[] = [];
    deps.credentialService.remove = async (hostId) => {
      calls.push(`credential:${hostId}`);
      return false;
    };
    deps.config.removeManagedHost = async (hostId) => {
      calls.push(`host:${hostId}`);
      return true;
    };
    const service = createSshService(deps);

    await expect(service.removeHost(host.id)).resolves.toBe(true);
    expect(calls).toEqual([`credential:${host.id}`, `host:${host.id}`]);
  });

  it("invalidates the related status after adding or updating a host", async () => {
    const deps = dependencies();
    let currentHost = host;
    let resolveCalls = 0;
    deps.config.listHosts = async () => ({ hosts: [currentHost], diagnostics: [] });
    deps.config.upsertManagedHost = async () => {
      currentHost = { ...host, hostname: "updated.example.test" };
      return currentHost;
    };
    deps.commands.resolve = async () => {
      resolveCalls += 1;
      return { hostname: currentHost.hostname, port: currentHost.port };
    };
    const service = createSshService(deps);

    await service.listHosts();
    await service.addHost({ alias: host.alias, hostname: "updated.example.test" });
    const result = await service.listHosts();

    expect(result.hosts[0].hostname).toBe("updated.example.test");
    expect(resolveCalls).toBe(2);
  });

  it("does not reuse or restore an in-flight list invalidated by a host update", async () => {
    const deps = dependencies();
    let currentHost = host;
    let resolveCalls = 0;
    let releaseFirstResolve!: () => void;
    let markFirstResolveStarted!: () => void;
    const firstResolvePending = new Promise<void>((resolve) => {
      releaseFirstResolve = resolve;
    });
    const firstResolveStarted = new Promise<void>((resolve) => {
      markFirstResolveStarted = resolve;
    });
    deps.config.listHosts = async () => ({ hosts: [currentHost], diagnostics: [] });
    deps.config.upsertManagedHost = async () => {
      currentHost = { ...host, hostname: "updated.example.test" };
      return currentHost;
    };
    deps.commands.resolve = async () => {
      resolveCalls += 1;
      const hostname = currentHost.hostname;
      if (resolveCalls === 1) {
        markFirstResolveStarted();
        await firstResolvePending;
      }
      return { hostname, port: currentHost.port };
    };
    const service = createSshService(deps);

    const staleRequest = service.listHosts();
    await firstResolveStarted;
    await service.addHost({ alias: host.alias, hostname: "updated.example.test" });
    const freshRequest = service.listHosts();

    expect(freshRequest).not.toBe(staleRequest);
    await expect(freshRequest).resolves.toMatchObject({ hosts: [{ hostname: "updated.example.test" }] });
    releaseFirstResolve();
    await staleRequest;
    await expect(service.listHosts()).resolves.toMatchObject({ hosts: [{ hostname: "updated.example.test" }] });
    expect(resolveCalls).toBe(2);
  });

  it("uses the latest host data when the resolved target changes", async () => {
    const deps = dependencies();
    let currentHost = host;
    let resolvedTarget = { hostname: "actual-one.example.test", port: 2201 };
    deps.config.listHosts = async () => ({ hosts: [currentHost], diagnostics: [] });
    deps.knownHosts.isTrusted = async () => true;
    deps.commands.resolve = async () => resolvedTarget;
    const service = createSshService(deps);

    await service.listHosts();
    currentHost = { ...host, hostname: "configured-two.example.test", port: 2202 };
    resolvedTarget = { hostname: "actual-two.example.test", port: 2203 };
    const result = await service.listHosts();

    expect(result.hosts[0]).toMatchObject({ hostname: "actual-two.example.test", port: 2203 });
  });

  it("keeps connect and openExternal host checks live after listing", async () => {
    const deps = dependencies();
    let trusted = false;
    let scanCalls = 0;
    deps.knownHosts.isTrusted = async () => trusted;
    deps.commands.scanFingerprint = async (target) => {
      scanCalls += 1;
      return { algorithm: "ED25519", value: "SHA256:one", hostname: target.hostname, port: target.port };
    };
    const service = createSshService(deps);

    await service.listHosts();
    trusted = true;
    await expect(service.connect(host.id)).resolves.toMatchObject({ hostId: host.id });
    await expect(service.openExternal(host.id, "iterm2")).resolves.toEqual({ terminal: "iterm2" });

    expect(scanCalls).toBe(3);
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
    deps.knownHosts.isTrusted = async () => true;
    deps.commands.resolve = async () => ({ hostname: "resolved.example.test", port: 2200 });
    deps.externalTerminal.open = async () => "iTerm2";
    const service = createSshService(deps);

    await expect(service.openExternal(host.id, "iterm2")).resolves.toEqual({ terminal: "iterm2" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operation: "open-external", hostId: host.id, resultCode: "iTerm2" });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("/usr/bin/ssh");
    expect(serialized).not.toContain("resolved.example.test");
    expect(serialized).not.toContain("2200");
  });

  it("opens the selected external terminal only after resolving and trusting the host", async () => {
    const calls: string[] = [];
    const deps = dependencies();
    deps.commands.resolve = async (alias) => {
      calls.push(`resolve:${alias}`);
      return { hostname: "resolved.example.test", port: 2200 };
    };
    deps.commands.scanFingerprint = async (target) => {
      calls.push(`scan:${target.hostname}:${target.port}`);
      return { algorithm: "ED25519", value: "SHA256:one", hostname: target.hostname, port: target.port };
    };
    deps.knownHosts.isTrusted = async (target, fingerprint) => {
      calls.push(`trust:${target.hostname}:${target.port}:${fingerprint.value}`);
      return true;
    };
    deps.externalTerminal.open = async (alias) => {
      calls.push(`open:${alias}`);
      return "iTerm2";
    };

    const service = createSshService(deps);

    await expect(service.openExternal(host.id, "iterm2")).resolves.toEqual({ terminal: "iterm2" });
    expect(calls).toEqual([
      "resolve:build-box",
      "scan:resolved.example.test:2200",
      "trust:resolved.example.test:2200:SHA256:one",
      "open:build-box",
    ]);
  });

  it("returns terminal for the system Terminal.app fallback", async () => {
    const deps = dependencies();
    deps.knownHosts.isTrusted = async () => true;
    deps.externalTerminal.open = async () => "Terminal.app";

    const service = createSshService(deps);

    await expect(service.openExternal(host.id, "terminal")).resolves.toEqual({ terminal: "terminal" });
  });

  it("does not open an external terminal for an untrusted host", async () => {
    const deps = dependencies();
    let opened = false;
    deps.externalTerminal.open = async () => {
      opened = true;
      return "iTerm2";
    };
    const service = createSshService(deps);

    await expect(service.openExternal(host.id, "iterm2")).rejects.toThrow("尚未信任");
    expect(opened).toBe(false);
  });

  it("does not resolve or open an external terminal when the host does not exist", async () => {
    const deps = dependencies();
    let resolved = false;
    let opened = false;
    deps.config.listHosts = async () => ({ hosts: [], diagnostics: [] });
    deps.commands.resolve = async () => {
      resolved = true;
      return { hostname: host.hostname, port: host.port };
    };
    deps.externalTerminal.open = async () => {
      opened = true;
      return "iTerm2";
    };
    const service = createSshService(deps);

    await expect(service.openExternal(host.id, "iterm2")).rejects.toThrow("SSH 主机不存在");
    expect(resolved).toBe(false);
    expect(opened).toBe(false);
  });
});
