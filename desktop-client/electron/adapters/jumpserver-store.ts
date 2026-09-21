import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { createKeyedMutex } from "../lib/async-mutex";
import { writeYamlFileAtomic } from "../lib/secure-store";

export type BastionInput = {
  alias: string;
  hostname: string;
  port: number;
  user: string;
  otpSecret?: string;
  syncFilter: { linuxOnly: boolean };
  jmsServerAlias: string;
  lastSyncedAt?: string;
  lastSyncAssetCount?: number;
  lastSyncSkippedCount?: number;
};

export type BastionRecord = BastionInput & { id: string };

export type JumpserverStoreOptions = {
  file: string;
  fileSystem?: Pick<typeof fs, "chmod" | "mkdir" | "readFile" | "rename" | "rm" | "writeFile">;
  createId?: () => string;
};

type StoreDocument = {
  version: 1;
  bastions: BastionRecord[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseDocument(value: unknown): StoreDocument {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.bastions)) throw new Error("AFK 堡垒机配置损坏");
  const bastions = value.bastions.map((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.alias !== "string" || typeof item.hostname !== "string" || typeof item.port !== "number" || typeof item.user !== "string") {
      throw new Error("AFK 堡垒机配置损坏");
    }
    return item as BastionRecord;
  });
  return { version: 1, bastions };
}

async function readDocument(fileSystem: Pick<typeof fs, "readFile">, file: string): Promise<StoreDocument> {
  let raw: string;
  try {
    raw = await fileSystem.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, bastions: [] };
    throw error;
  }
  try {
    return parseDocument(loadYaml(raw));
  } catch (error) {
    if (error instanceof Error && error.message === "AFK 堡垒机配置损坏") throw error;
    throw new Error("AFK 堡垒机配置损坏");
  }
}

async function writeDocument(
  fileSystem: Pick<typeof fs, "chmod" | "mkdir" | "rename" | "rm" | "writeFile">,
  file: string,
  document: StoreDocument,
) {
  await writeYamlFileAtomic(file, document, fileSystem);
}

export function createJumpserverStore({
  file,
  fileSystem = fs,
  createId = () => `managed:${randomUUID()}`,
}: JumpserverStoreOptions) {
  const keyedMutex = createKeyedMutex<void>();

  async function list(): Promise<BastionRecord[]> {
    return (await readDocument(fileSystem, file)).bastions;
  }

  async function get(id: string): Promise<BastionRecord | undefined> {
    const bastions = await list();
    return bastions.find((b) => b.id === id);
  }

  async function getByAlias(alias: string): Promise<BastionRecord | undefined> {
    const bastions = await list();
    return bastions.find((b) => b.alias === alias);
  }

  async function upsert(input: BastionInput): Promise<BastionRecord> {
    return keyedMutex.run(input.alias, async () => {
      const document = await readDocument(fileSystem, file);
      const existing = document.bastions.find((b) => b.alias === input.alias);
      const record: BastionRecord = { ...input, id: existing?.id || createId() };
      const bastions = existing
        ? document.bastions.map((b) => (b.id === existing.id ? record : b))
        : [...document.bastions, record];
      await writeDocument(fileSystem, file, { version: 1, bastions });
      return record;
    });
  }

  async function update(id: string, partial: Partial<BastionInput>): Promise<BastionRecord> {
    return keyedMutex.run(id, async () => {
      const document = await readDocument(fileSystem, file);
      const existing = document.bastions.find((b) => b.id === id);
      if (!existing) throw new Error("堡垒机不存在");
      const record: BastionRecord = { ...existing, ...partial, id: existing.id };
      await writeDocument(fileSystem, file, {
        version: 1,
        bastions: document.bastions.map((b) => (b.id === id ? record : b)),
      });
      return record;
    });
  }

  async function remove(id: string): Promise<boolean> {
    return keyedMutex.run(id, async () => {
      const document = await readDocument(fileSystem, file);
      if (!document.bastions.some((b) => b.id === id)) return false;
      const bastions = document.bastions.filter((b) => b.id !== id);
      await writeDocument(fileSystem, file, { version: 1, bastions });
      return true;
    });
  }

  return { list, get, getByAlias, upsert, update, remove };
}
