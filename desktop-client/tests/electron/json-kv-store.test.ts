import { promises as fs } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJsonKvStore } from "../../electron/adapters/json-kv-store";

type Snapshot = {
  value: string;
};

const directories: string[] = [];

function parseEntry(value: unknown): Snapshot {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { value?: unknown }).value !== "string") {
    throw new Error("invalid snapshot entry");
  }
  return { value: (value as { value: string }).value };
}

function createStore(file: string) {
  return createJsonKvStore({ file, version: 1, parseEntry });
}

async function createFile() {
  const directory = await mkdtemp(path.join(tmpdir(), "afk-json-snapshot-store-"));
  directories.push(directory);
  return path.join(directory, "snapshots.json");
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("JSON KV store", () => {
  it("reads entries after the store is recreated", async () => {
    const file = await createFile();
    const entry = { value: "cached" };

    await createStore(file).write("all", entry);

    await expect(createStore(file).read("all")).resolves.toEqual(entry);
  });

  it("parses values before persistence and removes extra fields", async () => {
    const file = await createFile();
    const store = createStore(file);

    await store.write("safe", { value: "kept", secret: "must-not-persist" } as Snapshot & { secret: string });

    const document = JSON.parse(await readFile(file, "utf8")) as { entries: Array<[string, unknown]> };
    expect(document.entries).toEqual([["safe", { value: "kept" }]]);
    expect(await readFile(file, "utf8")).not.toContain("must-not-persist");
  });

  it("rejects invalid values before creating a snapshot", async () => {
    const file = await createFile();

    await expect(createStore(file).write("invalid", { value: 42 } as unknown as Snapshot)).rejects.toThrow("invalid snapshot entry");
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats corrupt or mismatched documents as empty", async () => {
    const file = await createFile();

    await writeFile(file, "not-json", "utf8");
    await expect(createStore(file).entries()).resolves.toEqual([]);

    await writeFile(file, JSON.stringify({ version: 2, entries: [["all", { value: "stale" }]] }), "utf8");
    await expect(createStore(file).read("all")).resolves.toBeNull();
  });

  it("propagates real read errors", async () => {
    const file = await createFile();
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(error);

    await expect(createStore(file).entries()).rejects.toBe(error);
  });

  it("skips individual entries that fail parsing", async () => {
    const file = await createFile();
    await writeFile(file, JSON.stringify({
      version: 1,
      entries: [
        ["valid", { value: "kept" }],
        ["invalid", { value: 42 }],
        ["malformed", "not-an-entry"],
      ],
    }), "utf8");

    await expect(createStore(file).entries()).resolves.toEqual([["valid", { value: "kept" }]]);
    await expect(createStore(file).read("invalid")).resolves.toBeNull();
  });

  it("serializes concurrent writes without losing entries", async () => {
    const file = await createFile();
    const store = createStore(file);

    await Promise.all([
      store.write("first", { value: "one" }),
      store.write("second", { value: "two" }),
    ]);

    await expect(store.entries()).resolves.toEqual([
      ["first", { value: "one" }],
      ["second", { value: "two" }],
    ]);
  });

  it("serializes writes across store instances targeting the same file", async () => {
    const file = await createFile();
    const stores = Array.from({ length: 12 }, () => createStore(file));

    await Promise.all(stores.map((store, index) => store.write(`key-${index}`, { value: `value-${index}` })));

    const entries = await createStore(file).entries();
    expect(entries).toHaveLength(stores.length);
    expect(new Map(entries)).toEqual(new Map(stores.map((_, index) => [`key-${index}`, { value: `value-${index}` }])));
  });

  it("continues processing queued writes after one write fails", async () => {
    const file = await createFile();
    const store = createStore(file);
    const rename = vi.spyOn(fs, "rename").mockImplementationOnce(async () => {
      throw new Error("temporary write failure");
    });
    const firstWrite = store.write("failed", { value: "nope" });
    const secondWrite = store.write("recovered", { value: "yes" });

    await expect(firstWrite).rejects.toThrow("temporary write failure");
    rename.mockRestore();
    await expect(secondWrite).resolves.toBeUndefined();
    await expect(store.read("recovered")).resolves.toEqual({ value: "yes" });
  });

  it("creates the snapshot with mode 0o600", async () => {
    const file = await createFile();

    await createStore(file).write("all", { value: "private" });

    await expect(stat(file).then(result => result.mode & 0o777)).resolves.toBe(0o600);
  });

  it("keeps the existing snapshot intact and cleans the temporary file when rename fails", async () => {
    const file = await createFile();
    const store = createStore(file);
    await store.write("stable", { value: "original" });
    const original = await readFile(file, "utf8");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename failed"));

    await expect(store.write("unstable", { value: "replacement" })).rejects.toThrow("rename failed");

    await expect(readFile(file, "utf8")).resolves.toBe(original);
    const temporaryPrefix = `${path.basename(file)}.${process.pid}`;
    await expect(readdir(path.dirname(file))).resolves.not.toEqual(expect.arrayContaining([
      expect.stringMatching(new RegExp(`^${temporaryPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)),
    ]));
  });

  it("does not run a fallible chmod after the atomic rename", async () => {
    const file = await createFile();
    const store = createStore(file);
    await store.write("stable", { value: "original" });
    const chmod = fs.chmod.bind(fs);
    const chmodSpy = vi.spyOn(fs, "chmod").mockImplementation(async (target, mode) => {
      if (target === file) throw new Error("post-rename chmod failed");
      return chmod(target, mode);
    });

    await expect(store.write("stable", { value: "updated" })).resolves.toBeUndefined();
    expect(chmodSpy).not.toHaveBeenCalledWith(file, expect.anything());
    await expect(store.read("stable")).resolves.toEqual({ value: "updated" });
  });

  it("entries serializes against a concurrent write", async () => {
    const file = await createFile();
    const store = createStore(file);
    await store.write("initial", { value: "first" });

    const writeDone = store.write("during", { value: "second" });
    const entriesDuringWrite = store.entries();
    const blockerDone = store.write("blocker", { value: "third" });

    await expect(entriesDuringWrite).resolves.toEqual([
      ["initial", { value: "first" }],
      ["during", { value: "second" }],
    ]);
    await Promise.all([writeDone, blockerDone]);
    await expect(store.entries()).resolves.toHaveLength(3);
  });

  it("deletes one entry and clears all entries", async () => {
    const file = await createFile();
    const store = createStore(file);
    await store.write("first", { value: "one" });
    await store.write("second", { value: "two" });

    await store.delete("first");
    await expect(store.entries()).resolves.toEqual([["second", { value: "two" }]]);

    await store.clear();
    await expect(store.entries()).resolves.toEqual([]);
    await expect(readFile(file, "utf8")).resolves.toContain('"entries":[]');
  });
});
