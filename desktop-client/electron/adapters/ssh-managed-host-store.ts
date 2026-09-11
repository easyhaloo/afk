import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import type { ManagedSshHostInput, ManagedSshHostRecord } from "../../shared/ssh-contract";
import { validateSshHostInput, validateSshHostId } from "../security/ssh-validation";

type FileSystem = Pick<typeof fs, "chmod" | "mkdir" | "readFile" | "rename" | "rm" | "writeFile">;

type StoreDocument = {
  version: 1;
  hosts: ManagedSshHostRecord[];
};

type StoreOptions = {
  file: string;
  fileSystem?: FileSystem;
  createId?: () => string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseDocument(value: unknown): StoreDocument {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.hosts)) throw new Error("AFK SSH 主机配置损坏");
  const hosts = value.hosts.map((item) => {
    if (!isRecord(item) || typeof item.id !== "string") throw new Error("AFK SSH 主机配置损坏");
    const input = validateSshHostInput(item);
    validateSshHostId(item.id);
    return { ...input, id: item.id };
  });
  if (new Set(hosts.map((item) => item.id)).size !== hosts.length) throw new Error("AFK SSH 主机配置损坏");
  return { version: 1, hosts };
}

async function readDocument(fileSystem: FileSystem, file: string): Promise<StoreDocument> {
  let raw: string;
  try {
    raw = await fileSystem.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, hosts: [] };
    throw error;
  }
  try {
    return parseDocument(loadYaml(raw));
  } catch (error) {
    if (error instanceof Error && error.message === "AFK SSH 主机配置损坏") throw error;
    throw new Error("AFK SSH 主机配置损坏");
  }
}

async function writeDocument(fileSystem: FileSystem, file: string, document: StoreDocument) {
  await fileSystem.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fileSystem.writeFile(temporary, dumpYaml(document, { noRefs: true, lineWidth: -1 }), { encoding: "utf8", mode: 0o600 });
    await fileSystem.chmod(temporary, 0o600);
    await fileSystem.rename(temporary, file);
    await fileSystem.chmod(file, 0o600);
  } catch (error) {
    await fileSystem.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function createSshManagedHostStore({ file, fileSystem = fs, createId = () => `managed:${randomUUID()}` }: StoreOptions) {
  let mutationQueue = Promise.resolve();

  function mutate<T>(operation: () => Promise<T>) {
    const next = mutationQueue.then(operation, operation);
    mutationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  async function list() {
    return (await readDocument(fileSystem, file)).hosts;
  }

  async function upsert(value: ManagedSshHostInput) {
    const input = validateSshHostInput(value);
    return mutate(async () => {
      const document = await readDocument(fileSystem, file);
      const existing = document.hosts.find((item) => item.alias === input.alias);
      const record = { ...input, id: existing?.id || createId() };
      const hosts = existing ? document.hosts.map((item) => item.id === existing.id ? record : item) : [...document.hosts, record];
      await writeDocument(fileSystem, file, { version: 1, hosts });
      return record;
    });
  }

  async function update(id: string, value: ManagedSshHostInput) {
    const hostId = validateSshHostId(id);
    const input = validateSshHostInput(value);
    return mutate(async () => {
      const document = await readDocument(fileSystem, file);
      if (!document.hosts.some((item) => item.id === hostId)) throw new Error("SSH 主机不存在");
      if (document.hosts.some((item) => item.id !== hostId && item.alias === input.alias)) throw new Error("SSH 主机名称已存在");
      const record = { ...input, id: hostId };
      await writeDocument(fileSystem, file, { version: 1, hosts: document.hosts.map((item) => item.id === hostId ? record : item) });
      return record;
    });
  }

  async function remove(id: string) {
    const hostId = validateSshHostId(id);
    return mutate(async () => {
      const document = await readDocument(fileSystem, file);
      const hosts = document.hosts.filter((item) => item.id !== hostId);
      if (hosts.length === document.hosts.length) return false;
      await writeDocument(fileSystem, file, { version: 1, hosts });
      return true;
    });
  }

  return { list, upsert, update, remove };
}
