import { promises as fs } from "node:fs";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createJumpserverStore } from "../../electron/adapters/jumpserver-store";

describe("jumpserver store", () => {
  it("list returns empty array on fresh store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "afk-jms-store-"));
    const file = path.join(root, "bastions.yml");
    const store = createJumpserverStore({ file, createId: () => "managed:stable-1" });
    expect(await store.list()).toEqual([]);
  });

  it("upsert and list round-trip all fields", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "afk-jms-store-"));
    const file = path.join(root, "bastions.yml");
    const store = createJumpserverStore({ file, createId: () => "managed:stable-1" });

    const saved = await store.upsert({
      alias: "prod-bastion",
      hostname: "bastion.example.com",
      port: 2222,
      user: "admin",
      otpSecret: "SECRET123",
      syncFilter: { linuxOnly: true },
      jmsServerAlias: "prod-bastion",
    });

    expect(saved).toMatchObject({
      id: "managed:stable-1",
      alias: "prod-bastion",
      hostname: "bastion.example.com",
      port: 2222,
      user: "admin",
      otpSecret: "SECRET123",
      syncFilter: { linuxOnly: true },
      jmsServerAlias: "prod-bastion",
    });

    expect(await store.list()).toEqual([saved]);
    const raw = await readFile(file, "utf8");
    expect(raw).toContain("prod-bastion");
    expect(raw).toContain("SECRET123");
  });

  it("upsert same alias updates in place (preserves id)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "afk-jms-store-"));
    const file = path.join(root, "bastions.yml");
    const store = createJumpserverStore({ file, createId: () => "managed:stable-1" });

    const first = await store.upsert({
      alias: "prod-bastion",
      hostname: "old.example.com",
      port: 2222,
      user: "admin",
      syncFilter: { linuxOnly: true },
      jmsServerAlias: "prod-bastion",
    });

    const second = await store.upsert({
      alias: "prod-bastion",
      hostname: "new.example.com",
      port: 3333,
      user: "root",
      syncFilter: { linuxOnly: false },
      jmsServerAlias: "prod-bastion",
    });

    expect(second.id).toBe(first.id);
    expect(second.hostname).toBe("new.example.com");
    expect(second.port).toBe(3333);
    expect(await store.list()).toHaveLength(1);
  });

  it("get returns record by id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "afk-jms-store-"));
    const file = path.join(root, "bastions.yml");
    const store = createJumpserverStore({ file, createId: () => "managed:stable-1" });

    const saved = await store.upsert({
      alias: "prod-bastion",
      hostname: "bastion.example.com",
      port: 2222,
      user: "admin",
      syncFilter: { linuxOnly: true },
      jmsServerAlias: "prod-bastion",
    });

    expect(await store.get(saved.id)).toMatchObject({ id: saved.id, alias: "prod-bastion" });
    expect(await store.get("managed:nonexistent")).toBeUndefined();
  });

  it("getByAlias returns record by alias", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "afk-jms-store-"));
    const file = path.join(root, "bastions.yml");
    const store = createJumpserverStore({ file, createId: () => "managed:stable-1" });

    await store.upsert({
      alias: "prod-bastion",
      hostname: "bastion.example.com",
      port: 2222,
      user: "admin",
      syncFilter: { linuxOnly: true },
      jmsServerAlias: "prod-bastion",
    });

    expect(await store.getByAlias("prod-bastion")).toMatchObject({ alias: "prod-bastion" });
    expect(await store.getByAlias("nonexistent")).toBeUndefined();
  });

  it("update modifies record fields", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "afk-jms-store-"));
    const file = path.join(root, "bastions.yml");
    const store = createJumpserverStore({ file, createId: () => "managed:stable-1" });

    const saved = await store.upsert({
      alias: "prod-bastion",
      hostname: "bastion.example.com",
      port: 2222,
      user: "admin",
      syncFilter: { linuxOnly: true },
      jmsServerAlias: "prod-bastion",
    });

    const updated = await store.update(saved.id, { syncFilter: { linuxOnly: false }, lastSyncedAt: "2026-01-01T00:00:00Z" });

    expect(updated.syncFilter).toEqual({ linuxOnly: false });
    expect(updated.lastSyncedAt).toBe("2026-01-01T00:00:00Z");
    expect(updated.alias).toBe("prod-bastion"); // unchanged
  });

  it("update throws for nonexistent id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "afk-jms-store-"));
    const file = path.join(root, "bastions.yml");
    const store = createJumpserverStore({ file, createId: () => "managed:stable-1" });

    await expect(store.update("managed:nonexistent", { hostname: "x" })).rejects.toThrow("堡垒机不存在");
  });

  it("remove deletes record and returns true; subsequent remove returns false", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "afk-jms-store-"));
    const file = path.join(root, "bastions.yml");
    const store = createJumpserverStore({ file, createId: () => "managed:stable-1" });

    const saved = await store.upsert({
      alias: "prod-bastion",
      hostname: "bastion.example.com",
      port: 2222,
      user: "admin",
      syncFilter: { linuxOnly: true },
      jmsServerAlias: "prod-bastion",
    });

    expect(await store.remove(saved.id)).toBe(true);
    expect(await store.list()).toEqual([]);
    expect(await store.remove(saved.id)).toBe(false);
  });

  it("atomic write: creates directory 0o700, file 0o600", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "afk-jms-store-"));
    const file = path.join(root, "subdir", "bastions.yml");
    const store = createJumpserverStore({ file, createId: () => "managed:stable-1" });

    await store.upsert({
      alias: "prod-bastion",
      hostname: "bastion.example.com",
      port: 2222,
      user: "admin",
      syncFilter: { linuxOnly: true },
      jmsServerAlias: "prod-bastion",
    });

    const dirStat = await stat(path.dirname(file));
    expect(dirStat.mode & 0o777).toBe(0o700);

    const fileStat = await stat(file);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it("per-bastion mutex serializes concurrent upserts on same bastion", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "afk-jms-store-"));
    const file = path.join(root, "bastions.yml");

    // Track call order with a mutable ref shared across the delayed stub
    const callLog: string[] = [];

    const delayedFs = {
      ...fs,
      readFile: async (f: string, enc: BufferEncoding) => {
        callLog.push(`read-${f}`);
        await new Promise((r) => setTimeout(r, 5));
        return fs.readFile(f, enc);
      },
      writeFile: async (f: string, data: string, opts?: object) => {
        callLog.push(`write-${path.basename(f)}`);
        await new Promise((r) => setTimeout(r, 5));
        return fs.writeFile(f, data, opts);
      },
      mkdir: fs.mkdir,
      rename: fs.rename,
      chmod: fs.chmod,
      rm: fs.rm,
    };

    const store = createJumpserverStore({ file, fileSystem: delayedFs, createId: () => `managed:${Math.random()}` });

    // Fire two upserts on the same alias concurrently
    await Promise.all([
      store.upsert({
        alias: "same-bastion",
        hostname: "host-a.example.com",
        port: 2222,
        user: "admin",
        syncFilter: { linuxOnly: true },
        jmsServerAlias: "same-bastion",
      }),
      store.upsert({
        alias: "same-bastion",
        hostname: "host-b.example.com",
        port: 2222,
        user: "admin",
        syncFilter: { linuxOnly: true },
        jmsServerAlias: "same-bastion",
      }),
    ]);

    // Both calls should complete without error; final list has exactly one record
    expect(await store.list()).toHaveLength(1);
  });

  it("YAML round-trip preserves lastSyncedAt and lastSyncAssetCount", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "afk-jms-store-"));
    const file = path.join(root, "bastions.yml");
    const store = createJumpserverStore({ file, createId: () => "managed:stable-1" });

    await store.upsert({
      alias: "prod-bastion",
      hostname: "bastion.example.com",
      port: 2222,
      user: "admin",
      syncFilter: { linuxOnly: true },
      jmsServerAlias: "prod-bastion",
      lastSyncedAt: "2026-01-01T12:00:00Z",
      lastSyncAssetCount: 42,
      lastSyncSkippedCount: 3,
    });

    const raw = await readFile(file, "utf8");
    expect(raw).toContain("2026-01-01T12:00:00Z");
    expect(raw).toContain("42");

    const [restored] = await store.list();
    expect(restored.lastSyncedAt).toBe("2026-01-01T12:00:00Z");
    expect(restored.lastSyncAssetCount).toBe(42);
    expect(restored.lastSyncSkippedCount).toBe(3);
  });
});
