import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { SqliteLocalConfigStore } from "@afk/runtime/storage";
import { createLegacyLocalConfigReady, createSqliteJumpserverStore, createSqliteSshManagedHostStore } from "../../electron/adapters/sqlite-local-config-adapters.js";
import { createJumpserverStore } from "../../electron/adapters/jumpserver-store.js";
import { createSshManagedHostStore } from "../../electron/adapters/ssh-managed-host-store.js";

describe("SQLite local configuration adapters", () => {
  it("keeps JumpServer credentials in the credential service boundary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "afk-desktop-config-adapter-"));
    const local = new SqliteLocalConfigStore({ file: path.join(root, "config.sqlite") });
    const bastions = createSqliteJumpserverStore(local);
    const hosts = createSqliteSshManagedHostStore(local);

    const bastion = await bastions.upsert({
      alias: "prod",
      hostname: "bastion.example.com",
      port: 2222,
      user: "admin",
      otpSecret: "must-not-persist",
      syncFilter: { linuxOnly: true },
      jmsServerAlias: "prod",
    });
    const host = await hosts.upsert({
      alias: "web-01",
      hostname: "10.0.0.1",
      port: 22,
      user: "root",
      jumpHostType: "jumpserver",
      jumpHost: "prod",
    });

    expect(bastion).not.toHaveProperty("otpSecret");
    expect((await hosts.list())[0]).toMatchObject({ id: host.id, jumpHost: "prod" });
    expect((await local.listHosts())[0]).toMatchObject({ id: host.id, bastionId: bastion.id });
    local.close();
  });

  it("imports legacy YAML once without copying OTP secrets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "afk-desktop-config-migration-"));
    const hostFile = path.join(root, "ssh-hosts.yml");
    const bastionFile = path.join(root, "jumpserver-bastions.yml");
    await createJumpserverStore({ file: bastionFile }).upsert({ alias: "prod", hostname: "bastion.example.com", port: 2222, user: "admin", otpSecret: "secret", syncFilter: { linuxOnly: true }, jmsServerAlias: "prod" });
    await createSshManagedHostStore({ file: hostFile }).upsert({ alias: "web-01", hostname: "10.0.0.1", port: 22, user: "root", jumpHostType: "jumpserver", jumpHost: "prod" });
    const local = new SqliteLocalConfigStore({ file: path.join(root, "config.sqlite") });
    const ready = createLegacyLocalConfigReady(local, { hostFile, bastionFile });
    const hosts = createSqliteSshManagedHostStore(local, ready);
    const bastions = createSqliteJumpserverStore(local, ready);

    expect(await bastions.list()).toHaveLength(1);
    expect(await hosts.list()).toHaveLength(1);
    expect((await local.listBastions())[0]).not.toHaveProperty("otpSecret");
    expect((await local.listHosts())[0].bastionId).toBe((await local.listBastions())[0].id);
    local.close();
  });
});
