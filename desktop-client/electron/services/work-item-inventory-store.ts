import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  parseWorkItemInventoryOptions,
  parseWorkItemInventoryResult,
  type WorkItemInventoryOptions,
  type WorkItemInventoryResult,
} from "../../shared/backlog-contract";

const STORE_VERSION = 1;

export type StoredWorkItemInventory = {
  options: WorkItemInventoryOptions;
  inventory: WorkItemInventoryResult;
  syncedAt: string;
};

export type WorkItemInventoryStore = {
  read: (options: WorkItemInventoryOptions) => Promise<StoredWorkItemInventory | null>;
  write: (entry: StoredWorkItemInventory) => Promise<void>;
  clear: () => Promise<void>;
};

type StoreDocument = {
  version: number;
  entries: Record<string, StoredWorkItemInventory>;
};

export function workItemInventoryKey(options: WorkItemInventoryOptions): string {
  return JSON.stringify({
    platform: options.platform,
    state: options.state,
    executionMode: options.executionMode,
    tag: options.tag,
    project: options.project,
  });
}

export function createWorkItemInventoryStore(file: string): WorkItemInventoryStore {
  let documentPromise: Promise<StoreDocument> | undefined;
  let writeQueue = Promise.resolve();

  const load = async (): Promise<StoreDocument> => {
    if (!documentPromise) documentPromise = readDocument(file);
    return documentPromise;
  };

  const persist = async (document: StoreDocument): Promise<void> => {
    const directory = path.dirname(file);
    const temporary = `${file}.${process.pid}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, `${JSON.stringify(document)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
    documentPromise = Promise.resolve(document);
  };

  return {
    async read(options) {
      const document = await load();
      const entry = document.entries[workItemInventoryKey(options)];
      return entry ? parseStoredEntry(entry) : null;
    },
    async write(entry) {
      const operation = writeQueue.catch(() => undefined).then(async () => {
        const document = await load();
        document.entries[workItemInventoryKey(entry.options)] = parseStoredEntry(entry);
        await persist(document);
      });
      writeQueue = operation;
      await operation;
    },
    async clear() {
      const operation = writeQueue.catch(() => undefined).then(async () => {
        documentPromise = Promise.resolve({ version: STORE_VERSION, entries: {} });
        await rm(file, { force: true });
      });
      writeQueue = operation;
      await operation;
    },
  };
}

async function readDocument(file: string): Promise<StoreDocument> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return emptyDocument();
    const candidate = value as Record<string, unknown>;
    if (candidate.version !== STORE_VERSION || !candidate.entries || typeof candidate.entries !== "object" || Array.isArray(candidate.entries)) return emptyDocument();
    const entries: Record<string, StoredWorkItemInventory> = {};
    for (const [key, value] of Object.entries(candidate.entries)) {
      try {
        entries[key] = parseStoredEntry(value);
      } catch {
        continue;
      }
    }
    return { version: STORE_VERSION, entries };
  } catch {
    return emptyDocument();
  }
}

function parseStoredEntry(value: unknown): StoredWorkItemInventory {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid work item inventory entry");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.syncedAt !== "string") throw new Error("invalid work item inventory timestamp");
  const options = parseWorkItemInventoryOptions(candidate.options);
  const inventory = parseWorkItemInventoryResult(candidate.inventory);
  return { options, inventory, syncedAt: candidate.syncedAt };
}

function emptyDocument(): StoreDocument {
  return { version: STORE_VERSION, entries: {} };
}
