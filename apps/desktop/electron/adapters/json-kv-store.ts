import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export type JsonKvStore<T> = {
  read(key: string): Promise<T | null>;
  write(key: string, value: T): Promise<void>;
  entries(): Promise<Array<[string, T]>>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
};

type StoreOptions<T> = {
  file: string;
  version: number;
  parseEntry: (value: unknown) => T;
};

type StoreDocument = {
  version: number;
  entries: Array<[string, unknown]>;
};

const mutationQueues = new Map<string, Promise<void>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseDocument(value: unknown, version: number): StoreDocument | null {
  if (!isRecord(value) || value.version !== version || !Array.isArray(value.entries)) return null;

  const entries: Array<[string, unknown]> = [];
  for (const entry of value.entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") continue;
    entries.push([entry[0], entry[1]]);
  }
  return { version, entries };
}

export function createJsonKvStore<T>({ file, version, parseEntry }: StoreOptions<T>): JsonKvStore<T> {
  async function readDocument(): Promise<StoreDocument> {
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version, entries: [] };
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { version, entries: [] };
    }
    return parseDocument(parsed, version) ?? { version, entries: [] };
  }

  async function readEntries(): Promise<Array<[string, T]>> {
    const document = await readDocument();
    const entries: Array<[string, T]> = [];
    for (const [key, value] of document.entries) {
      try {
        entries.push([key, parseEntry(value)]);
      } catch {
        continue;
      }
    }
    return entries;
  }

  async function writeDocument(document: StoreDocument): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(document)}\n`, { encoding: "utf8", mode: 0o600 });
      await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, file);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  function mutate<Result>(operation: () => Promise<Result>): Promise<Result> {
    const previous = mutationQueues.get(file) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const recovered = next.then(() => undefined, () => undefined);
    mutationQueues.set(file, recovered);
    void recovered.then(() => {
      if (mutationQueues.get(file) === recovered) mutationQueues.delete(file);
    });
    return next;
  }

  return {
    async read(key) {
      for (const [entryKey, value] of await readEntries()) {
        if (entryKey === key) return value;
      }
      return null;
    },

    write(key, value) {
      return mutate(async () => {
        const parsedValue = parseEntry(value);
        const entries = await readEntries();
        const index = entries.findIndex(([entryKey]) => entryKey === key);
        if (index === -1) entries.push([key, parsedValue]);
        else entries[index] = [key, parsedValue];
        await writeDocument({ version, entries });
      });
    },

    entries() {
      return mutate(() => readEntries());
    },

    delete(key) {
      return mutate(async () => {
        const entries = (await readEntries()).filter(([entryKey]) => entryKey !== key);
        await writeDocument({ version, entries });
      });
    },

    clear() {
      return mutate(() => writeDocument({ version, entries: [] }));
    },
  };
}
