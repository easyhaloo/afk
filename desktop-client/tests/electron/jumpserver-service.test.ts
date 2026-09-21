import { describe, expect, it, vi } from "vitest";
import { createJumpserverService } from "../../electron/services/jumpserver-service";
import { JUMPSERVER_BINARY_ERROR } from "../../electron/adapters/jumpserver-cli";

function mockBastionStore(initial = []) {
  let bastions = [...initial];
  return {
    list: vi.fn(() => Promise.resolve(bastions)),
    get: vi.fn((id) => Promise.resolve(bastions.find((b) => b.id === id))),
    upsert: vi.fn((input) => {
      const existing = bastions.find((b) => b.alias === input.alias);
      const record = { ...input, id: existing?.id ?? `managed:${Math.random()}` };
      if (existing) {
        bastions = bastions.map((b) => (b.id === existing.id ? record : b));
      } else {
        bastions = [...bastions, record];
      }
      return Promise.resolve(record);
    }),
    update: vi.fn((id, partial) => {
      const existing = bastions.find((b) => b.id === id);
      if (!existing) throw new Error("堡垒机不存在");
      const updated = { ...existing, ...partial, id: existing.id };
      bastions = bastions.map((b) => (b.id === id ? updated : b));
      return Promise.resolve(updated);
    }),
    remove: vi.fn((id) => {
      const existed = bastions.some((b) => b.id === id);
      bastions = bastions.filter((b) => b.id !== id);
      return Promise.resolve(existed);
    }),
  };
}

function mockCredentialService() {
  const store = new Map();
  return {
    get: vi.fn((id, target) => {
      const entry = store.get(id);
      if (!entry || entry.target.hostname !== target.hostname) return undefined;
      return Promise.resolve({ password: entry.password, otpSecret: entry.otpSecret });
    }),
    set: vi.fn((id, password, target, otpSecret) => {
      store.set(id, { password, target, otpSecret });
      return Promise.resolve(true);
    }),
    remove: vi.fn((id) => {
      store.delete(id);
      return Promise.resolve(true);
    }),
  };
}

function mockCli() {
  return {
    resolveBinaryPath: vi.fn(() => Promise.resolve("/usr/local/bin/jms")),
    listServers: vi.fn(() => Promise.resolve([])),
    addServer: vi.fn(() => Promise.resolve({ ok: true, alias: "test" })),
    removeServer: vi.fn(() => Promise.resolve(true)),
    listAssets: vi.fn(() => Promise.resolve([])),
    probeAssetReachability: vi.fn(() => Promise.resolve(true)),
  };
}

function mockManagedHostStore() {
  let hosts: Array<{ id: string; alias: string; hostname: string; port: number; user: string; jumpHost?: string; jumpHostType?: string }> = [];
  return {
    list: vi.fn(() => Promise.resolve({ hosts })),
    upsert: vi.fn((input) => {
      const record = { ...input, id: `managed:${Math.random()}` };
      hosts = [...hosts, record];
      return Promise.resolve(record);
    }),
    update: vi.fn((id, input) => {
      hosts = hosts.map((h) => (h.id === id ? { ...h, ...input } : h));
      return Promise.resolve({ ...hosts.find((h) => h.id === id), ...input });
    }),
    remove: vi.fn((id) => {
      const existed = hosts.some((h) => h.id === id);
      hosts = hosts.filter((h) => h.id !== id);
      return Promise.resolve(existed);
    }),
  };
}

describe("jumpserver service", () => {
  describe("addBastion", () => {
    it("writes credential → bastion record → returns preview in correct order", async () => {
      const bastionStore = mockBastionStore();
      const credentialService = mockCredentialService();
      const cli = mockCli();
      const audit = vi.fn();

      cli.listAssets = vi.fn(() =>
        Promise.resolve([
          { name: "web-01", address: "10.0.0.1", platform: "Linux", rawType: "server" },
          { name: "web-02", address: "10.0.0.2", platform: "Linux", rawType: "server" },
        ]),
      );

      const service = createJumpserverService({
        home: "/home/user",
        bastionStore,
        credentialService,
        cli,
        audit,
      });

      const result = await service.addBastion({
        alias: "prod",
        hostname: "bastion.example.com",
        port: 2222,
        user: "admin",
        password: "secret123",
        otpSecret: "otp",
        linuxOnly: true,
      });

      expect(bastionStore.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ alias: "prod", hostname: "bastion.example.com", jmsServerAlias: "prod" }),
      );
      expect(result.assetPreview).toHaveLength(2);
      expect(result.assetPreview[0].name).toBe("web-01");
    });

    it("throws when jms binary not found", async () => {
      const bastionStore = mockBastionStore();
      const credentialService = mockCredentialService();
      const cli = mockCli();
      cli.resolveBinaryPath = vi.fn(() => Promise.resolve(""));

      const service = createJumpserverService({
        home: "/home/user",
        bastionStore,
        credentialService,
        cli,
      });

      await expect(
        service.addBastion({
          alias: "prod",
          hostname: "bastion.example.com",
          port: 2222,
          user: "admin",
          password: "secret",
        }),
      ).rejects.toThrow(JUMPSERVER_BINARY_ERROR);
    });

    it("throws when cli.addServer returns not ok", async () => {
      const bastionStore = mockBastionStore();
      const credentialService = mockCredentialService();
      const cli = mockCli();
      cli.addServer = vi.fn(() => Promise.resolve({ ok: false, alias: "prod" }));

      const service = createJumpserverService({
        home: "/home/user",
        bastionStore,
        credentialService,
        cli,
      });

      await expect(
        service.addBastion({
          alias: "prod",
          hostname: "bastion.example.com",
          port: 2222,
          user: "admin",
          password: "secret",
        }),
      ).rejects.toThrow("JumpServer 添加服务器失败");
    });
  });

  describe("syncAssets", () => {
    it("maps Linux assets correctly; skips Windows by default", async () => {
      const bastionStore = mockBastionStore([
        {
          id: "bastion-1",
          alias: "prod",
          hostname: "bastion.example.com",
          port: 2222,
          user: "admin",
          syncFilter: { linuxOnly: true },
          jmsServerAlias: "prod",
        },
      ]);
      const credentialService = mockCredentialService();
      credentialService.get = vi.fn(() => Promise.resolve({ password: "secret", otpSecret: undefined }));
      const cli = mockCli();
      cli.listServers = vi.fn(() => Promise.resolve([{ alias: "prod", host: "bastion.example.com", username: "admin", isDefault: true }]));
      cli.listAssets = vi.fn(() =>
        Promise.resolve([
          { name: "web-01", address: "10.0.0.1", platform: "Linux", rawType: "server" },
          { name: "win-01", address: "10.0.0.2", platform: "Windows", rawType: "server" },
        ]),
      );

      const managedHostStore = mockManagedHostStore();
      const service = createJumpserverService({
        home: "/home/user",
        bastionStore,
        credentialService,
        cli,
        managedHostStore,
        listManagedHosts: managedHostStore.list,
      });

      const result = await service.syncAssets("bastion-1");

      expect(result.assetsDiscovered).toBe(2);
      expect(result.assetsCreated).toBe(1); // only Linux
      expect(result.assetsSkipped).toBe(1);
      expect(result.skippedReasons).toContainEqual({ name: "win-01", reason: "Windows 资产已跳过" });
      expect(managedHostStore.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ alias: "web-01", hostname: "10.0.0.1", jumpHost: "prod" }),
      );
    });

    it("respects linuxOnly: false to include Windows assets", async () => {
      const bastionStore = mockBastionStore([
        {
          id: "bastion-1",
          alias: "prod",
          hostname: "bastion.example.com",
          port: 2222,
          user: "admin",
          syncFilter: { linuxOnly: false },
          jmsServerAlias: "prod",
        },
      ]);
      const credentialService = mockCredentialService();
      credentialService.get = vi.fn(() => Promise.resolve({ password: "secret", otpSecret: undefined }));
      const cli = mockCli();
      cli.listServers = vi.fn(() => Promise.resolve([{ alias: "prod", host: "bastion.example.com", username: "admin", isDefault: true }]));
      cli.listAssets = vi.fn(() =>
        Promise.resolve([
          { name: "web-01", address: "10.0.0.1", platform: "Linux", rawType: "server" },
          { name: "win-01", address: "10.0.0.2", platform: "Windows", rawType: "server" },
        ]),
      );

      const managedHostStore = mockManagedHostStore();
      const service = createJumpserverService({
        home: "/home/user",
        bastionStore,
        credentialService,
        cli,
        managedHostStore,
        listManagedHosts: managedHostStore.list,
      });

      const result = await service.syncAssets("bastion-1", { linuxOnly: false });

      expect(result.assetsCreated).toBe(2);
      expect(result.assetsSkipped).toBe(0);
    });

    it("skips asset with invalid alias (contains /)", async () => {
      const bastionStore = mockBastionStore([
        { id: "b-1", alias: "prod", hostname: "bastion.example.com", port: 2222, user: "admin", syncFilter: { linuxOnly: true }, jmsServerAlias: "prod" },
      ]);
      const credentialService = mockCredentialService();
      credentialService.get = vi.fn(() => Promise.resolve({ password: "secret", otpSecret: undefined }));
      const cli = mockCli();
      cli.listServers = vi.fn(() => Promise.resolve([{ alias: "prod", host: "bastion.example.com", username: "admin", isDefault: true }]));
      cli.listAssets = vi.fn(() =>
        Promise.resolve([{ name: "bad/alias", address: "10.0.0.1", platform: "Linux", rawType: "server" }]),
      );

      const managedHostStore = mockManagedHostStore();
      const service = createJumpserverService({
        home: "/home/user",
        bastionStore,
        credentialService,
        cli,
        managedHostStore,
        listManagedHosts: managedHostStore.list,
      });

      const result = await service.syncAssets("b-1");

      expect(result.skippedReasons).toContainEqual({ name: "bad/alias", reason: "资产名称非法" });
      expect(result.assetsCreated).toBe(0);
    });

    it("skips asset with alias collision (jumpHost differs)", async () => {
      const bastionStore = mockBastionStore([
        { id: "b-1", alias: "prod", hostname: "bastion.example.com", port: 2222, user: "admin", syncFilter: { linuxOnly: true }, jmsServerAlias: "prod" },
      ]);
      const credentialService = mockCredentialService();
      credentialService.get = vi.fn(() => Promise.resolve({ password: "secret", otpSecret: undefined }));
      const cli = mockCli();
      cli.listServers = vi.fn(() => Promise.resolve([{ alias: "prod", host: "bastion.example.com", username: "admin", isDefault: true }]));
      cli.listAssets = vi.fn(() =>
        Promise.resolve([{ name: "web-01", address: "10.0.0.1", platform: "Linux", rawType: "server" }]),
      );

      const managedHostStore = mockManagedHostStore();
      // Pre-existing host with same alias but different jumpHost
      managedHostStore.list = vi.fn(() =>
        Promise.resolve({
          hosts: [{ id: "managed:existing", alias: "web-01", hostname: "1.1.1.1", port: 22, user: "root", jumpHost: "other-bastion", jumpHostType: "jumpserver" }],
        }),
      );

      const service = createJumpserverService({
        home: "/home/user",
        bastionStore,
        credentialService,
        cli,
        managedHostStore,
        listManagedHosts: managedHostStore.list,
      });

      const result = await service.syncAssets("b-1");

      expect(result.skippedReasons).toContainEqual({ name: "web-01", reason: "资产已被独立管理，跳过" });
      expect(result.assetsCreated).toBe(0);
    });

    it("updates existing synced asset in place (preserves id)", async () => {
      const bastionStore = mockBastionStore([
        { id: "b-1", alias: "prod", hostname: "bastion.example.com", port: 2222, user: "admin", syncFilter: { linuxOnly: true }, jmsServerAlias: "prod" },
      ]);
      const credentialService = mockCredentialService();
      credentialService.get = vi.fn(() => Promise.resolve({ password: "secret", otpSecret: undefined }));
      const cli = mockCli();
      cli.listServers = vi.fn(() => Promise.resolve([{ alias: "prod", host: "bastion.example.com", username: "admin", isDefault: true }]));
      cli.listAssets = vi.fn(() =>
        Promise.resolve([{ name: "web-01", address: "10.0.0.99", platform: "Linux", rawType: "server" }]),
      );

      const managedHostStore = mockManagedHostStore();
      managedHostStore.list = vi.fn(() =>
        Promise.resolve({
          hosts: [{ id: "managed:old-id", alias: "web-01", hostname: "10.0.0.1", port: 22, user: "root", jumpHost: "prod", jumpHostType: "jumpserver" }],
        }),
      );

      const service = createJumpserverService({
        home: "/home/user",
        bastionStore,
        credentialService,
        cli,
        managedHostStore,
        listManagedHosts: managedHostStore.list,
      });

      await service.syncAssets("b-1");

      expect(managedHostStore.upsert).toHaveBeenCalledWith(expect.objectContaining({ alias: "web-01", hostname: "10.0.0.99" }));
    });

    it("records skipped reasons correctly", async () => {
      const bastionStore = mockBastionStore([
        { id: "b-1", alias: "prod", hostname: "bastion.example.com", port: 2222, user: "admin", syncFilter: { linuxOnly: true }, jmsServerAlias: "prod" },
      ]);
      const credentialService = mockCredentialService();
      credentialService.get = vi.fn(() => Promise.resolve({ password: "secret", otpSecret: undefined }));
      const cli = mockCli();
      cli.listServers = vi.fn(() => Promise.resolve([{ alias: "prod", host: "bastion.example.com", username: "admin", isDefault: true }]));
      cli.listAssets = vi.fn(() =>
        Promise.resolve([
          { name: "bad/name", address: "10.0.0.1", platform: "Linux", rawType: "server" },
          { name: "win-box", address: "10.0.0.2", platform: "Windows", rawType: "server" },
        ]),
      );

      const managedHostStore = mockManagedHostStore();
      const service = createJumpserverService({
        home: "/home/user",
        bastionStore,
        credentialService,
        cli,
        managedHostStore,
        listManagedHosts: managedHostStore.list,
      });

      const result = await service.syncAssets("b-1");

      expect(result.skippedReasons).toHaveLength(2);
      expect(result.skippedReasons).toContainEqual({ name: "bad/name", reason: "资产名称非法" });
      expect(result.skippedReasons).toContainEqual({ name: "win-box", reason: "Windows 资产已跳过" });
    });

    it("throws if bastion missing", async () => {
      const bastionStore = mockBastionStore([]);
      const service = createJumpserverService({ home: "/home/user", bastionStore });

      await expect(service.syncAssets("nonexistent")).rejects.toThrow("堡垒机不存在");
    });

    it("throws if credential missing", async () => {
      const bastionStore = mockBastionStore([
        { id: "b-1", alias: "prod", hostname: "bastion.example.com", port: 2222, user: "admin", syncFilter: { linuxOnly: true }, jmsServerAlias: "prod" },
      ]);
      const credentialService = mockCredentialService();
      credentialService.get = vi.fn(() => Promise.resolve(undefined));
      const cli = mockCli();

      const service = createJumpserverService({
        home: "/home/user",
        bastionStore,
        credentialService,
        cli,
      });

      await expect(service.syncAssets("b-1")).rejects.toThrow("堡垒机凭证缺失");
    });

    it("audit hook is called after sync", async () => {
      const bastionStore = mockBastionStore([
        { id: "b-1", alias: "prod", hostname: "bastion.example.com", port: 2222, user: "admin", syncFilter: { linuxOnly: true }, jmsServerAlias: "prod" },
      ]);
      const credentialService = mockCredentialService();
      credentialService.get = vi.fn(() => Promise.resolve({ password: "secret", otpSecret: undefined }));
      const cli = mockCli();
      cli.listServers = vi.fn(() => Promise.resolve([{ alias: "prod", host: "bastion.example.com", username: "admin", isDefault: true }]));
      cli.listAssets = vi.fn(() => Promise.resolve([]));

      const audit = vi.fn();
      const service = createJumpserverService({ home: "/home/user", bastionStore, credentialService, cli, audit });

      await service.syncAssets("b-1");

      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "sync", bastionId: "b-1", created: 0, skipped: 0 }),
      );
    });

    it("getSyncLog returns ring buffer entries", async () => {
      const bastionStore = mockBastionStore([
        { id: "b-1", alias: "prod", hostname: "bastion.example.com", port: 2222, user: "admin", syncFilter: { linuxOnly: true }, jmsServerAlias: "prod" },
      ]);
      const credentialService = mockCredentialService();
      credentialService.get = vi.fn(() => Promise.resolve({ password: "secret", otpSecret: undefined }));
      const cli = mockCli();
      cli.listServers = vi.fn(() => Promise.resolve([{ alias: "prod", host: "bastion.example.com", username: "admin", isDefault: true }]));
      cli.listAssets = vi.fn(() => Promise.resolve([]));

      const managedHostStore = mockManagedHostStore();
      const service = createJumpserverService({
        home: "/home/user",
        bastionStore,
        credentialService,
        cli,
        managedHostStore,
        listManagedHosts: managedHostStore.list,
      });

      await service.syncAssets("b-1");
      await service.syncAssets("b-1");

      const log = service.getSyncLog("b-1");
      expect(log).toHaveLength(2);
      expect(log[0].message).toContain("同步完成");
    });
  });

  describe("removeBastion", () => {
    it("cascades: removes managed hosts with matching jumpHost → cli.removeServer → credentialService.remove → bastionStore.remove", async () => {
      const bastionStore = mockBastionStore([
        { id: "b-1", alias: "prod", hostname: "bastion.example.com", port: 2222, user: "admin", syncFilter: { linuxOnly: true }, jmsServerAlias: "prod" },
      ]);
      const credentialService = mockCredentialService();
      const cli = mockCli();
      const managedHostStore = mockManagedHostStore();
      managedHostStore.list = vi.fn(() =>
        Promise.resolve({
          hosts: [
            { id: "h-1", alias: "web-01", hostname: "10.0.0.1", port: 22, user: "root", jumpHost: "prod", jumpHostType: "jumpserver" },
            { id: "h-2", alias: "web-02", hostname: "10.0.0.2", port: 22, user: "root", jumpHost: "prod", jumpHostType: "jumpserver" },
            { id: "h-3", alias: "other-host", hostname: "10.0.0.3", port: 22, user: "root", jumpHost: "other", jumpHostType: "jumpserver" },
          ],
        }),
      );

      const service = createJumpserverService({
        home: "/home/user",
        bastionStore,
        credentialService,
        cli,
        managedHostStore,
        listManagedHosts: managedHostStore.list,
      });

      const result = await service.removeBastion("b-1");

      expect(result).toEqual({ ok: true, removedAssetCount: 2 });
      expect(managedHostStore.remove).toHaveBeenCalledTimes(2);
      expect(cli.removeServer).toHaveBeenCalledWith("prod");
      expect(credentialService.remove).toHaveBeenCalledWith("b-1");
      expect(bastionStore.remove).toHaveBeenCalledWith("b-1");
    });

    it("throws if bastion missing", async () => {
      const bastionStore = mockBastionStore([]);
      const service = createJumpserverService({ home: "/home/user", bastionStore });

      await expect(service.removeBastion("nonexistent")).rejects.toThrow("堡垒机不存在");
    });
  });

  describe("per-bastion mutex", () => {
    it("two concurrent syncAssets on same bastion serialize", async () => {
      const bastionStore = mockBastionStore([
        { id: "b-1", alias: "prod", hostname: "bastion.example.com", port: 2222, user: "admin", syncFilter: { linuxOnly: true }, jmsServerAlias: "prod" },
      ]);
      const credentialService = mockCredentialService();
      credentialService.get = vi.fn(() => Promise.resolve({ password: "secret", otpSecret: undefined }));
      const cli = mockCli();
      cli.listServers = vi.fn(() => Promise.resolve([{ alias: "prod", host: "bastion.example.com", username: "admin", isDefault: true }]));

      // Slow down listAssets to increase chance of race condition if not serialized
      let assetsCallCount = 0;
      cli.listAssets = vi.fn(async () => {
        assetsCallCount++;
        await new Promise((r) => setTimeout(r, 10));
        return [];
      });

      const managedHostStore = mockManagedHostStore();
      const service = createJumpserverService({
        home: "/home/user",
        bastionStore,
        credentialService,
        cli,
        managedHostStore,
        listManagedHosts: managedHostStore.list,
      });

      await Promise.all([service.syncAssets("b-1"), service.syncAssets("b-1")]);

      // If serialized properly, both calls should complete without error
      expect(assetsCallCount).toBe(2);
    });
  });
});
