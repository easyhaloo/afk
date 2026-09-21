import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkItemInventoryStore } from "../../electron/services/work-item-inventory-store";

const inventory = {
  items: [],
  projects: [],
  diagnostics: [],
  complete: true,
};

const options = { platform: "all" as const };
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("work item inventory store", () => {
  it("persists validated snapshots and reads them after recreation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "afk-inventory-store-"));
    directories.push(directory);
    const file = path.join(directory, "inventory.json");
    const entry = { options, inventory, syncedAt: "2026-09-21T00:00:00.000Z" };

    await createWorkItemInventoryStore(file).write(entry);

    await expect(createWorkItemInventoryStore(file).read(options)).resolves.toEqual(entry);
    await expect(readFile(file, "utf8")).resolves.toContain('"version":1');
  });

  it("ignores corrupt snapshots instead of breaking page loading", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "afk-inventory-store-"));
    directories.push(directory);
    const file = path.join(directory, "inventory.json");
    await import("node:fs/promises").then(fs => fs.writeFile(file, "not-json", "utf8"));

    await expect(createWorkItemInventoryStore(file).read(options)).resolves.toBeNull();
  });
});
