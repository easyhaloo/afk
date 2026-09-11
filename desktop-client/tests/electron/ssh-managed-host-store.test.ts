import { promises as fs } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSshManagedHostStore } from "../../electron/adapters/ssh-managed-host-store";

describe("SSH managed host store", () => {
  it("round-trips Chinese display names with a stable id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "afk-ssh-store-"));
    const file = path.join(root, "ssh-hosts.yml");
    const store = createSshManagedHostStore({ file, createId: () => "managed:stable-1" });

    const saved = await store.upsert({ alias: "kg演示", hostname: "172.16.0.241", port: 22, user: "root" });
    expect(saved).toMatchObject({ id: "managed:stable-1", alias: "kg演示", hostname: "172.16.0.241" });
    expect(await store.list()).toEqual([saved]);
    expect(await readFile(file, "utf8")).toContain("kg演示");
  });

  it("updates and removes by stable id without changing OpenSSH files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "afk-ssh-store-"));
    const file = path.join(root, "ssh-hosts.yml");
    const store = createSshManagedHostStore({ file, createId: () => "managed:stable-1" });
    const saved = await store.upsert({ alias: "kg演示", hostname: "172.16.0.241" });

    await store.update(saved.id, { alias: "生产机", hostname: "192.0.2.10" });
    expect(await store.list()).toEqual([{ id: saved.id, alias: "生产机", hostname: "192.0.2.10", port: 22 }]);
    await expect(store.remove(saved.id)).resolves.toBe(true);
    expect(await store.list()).toEqual([]);
    expect(await fs.stat(file)).toBeTruthy();
  });
});
