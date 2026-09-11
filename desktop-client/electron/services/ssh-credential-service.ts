import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { validateSshHostId } from "../security/ssh-validation";

const CREDENTIAL_FILE = path.join(".config", "afk", "ssh-credentials.json");
const MAX_PASSWORD_BYTES = 4096;

type SecureStorage = {
  isEncryptionAvailable: () => boolean;
  encryptString: (value: string) => Buffer;
  decryptString: (value: Buffer) => string;
};

export type SshCredentialTarget = {
  hostname: string;
  port: number;
  user?: string;
};

type CredentialFileSystem = Pick<typeof fs, "chmod" | "mkdir" | "readFile" | "rename" | "rm" | "writeFile">;

type CredentialRecord = {
  encrypted: string;
  target: SshCredentialTarget;
};

type CredentialDocument = {
  version: 1;
  credentials: Record<string, CredentialRecord | string>;
};

type SshCredentialServiceDependencies = {
  home: string;
  safeStorage: SecureStorage;
  fileSystem?: CredentialFileSystem;
};

function unavailable() {
  return new Error("SSH 凭据安全存储不可用");
}

function corrupted() {
  return new Error("SSH 凭据文件损坏");
}

function invalidPassword() {
  return new Error("SSH 部署密码无效");
}

function validatePassword(password: string) {
  if (!password || password.includes("\0") || password.includes("\r") || password.includes("\n") || Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) throw invalidPassword();
}

function normalizeTarget(target: SshCredentialTarget): SshCredentialTarget {
  if (!target || typeof target !== "object" || typeof target.hostname !== "string" || !target.hostname || typeof target.port !== "number" || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || (target.user !== undefined && (typeof target.user !== "string" || !target.user))) throw new Error("SSH 目标参数无效");
  return target.user === undefined ? { hostname: target.hostname, port: target.port } : { hostname: target.hostname, port: target.port, user: target.user };
}

function isTarget(value: unknown): value is SshCredentialTarget {
  try {
    normalizeTarget(value as SshCredentialTarget);
    return true;
  } catch {
    return false;
  }
}

function isCredentialRecord(value: unknown): value is CredentialRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return typeof input.encrypted === "string" && input.encrypted.length > 0 && isTarget(input.target);
}

function isDocument(value: unknown): value is CredentialDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || !input.credentials || typeof input.credentials !== "object" || Array.isArray(input.credentials)) return false;
  return Object.values(input.credentials as Record<string, unknown>).every((item) => (typeof item === "string" && item.length > 0) || isCredentialRecord(item));
}

function sameTarget(left: SshCredentialTarget, right: SshCredentialTarget) {
  return left.hostname === right.hostname && left.port === right.port && left.user === right.user;
}

export function createSshCredentialService({ home, safeStorage, fileSystem = fs }: SshCredentialServiceDependencies) {
  const file = path.join(home, CREDENTIAL_FILE);
  const directory = path.dirname(file);
  let mutationQueue = Promise.resolve();

  function assertAvailable() {
    if (!safeStorage.isEncryptionAvailable()) throw unavailable();
  }

  async function readDocument(): Promise<CredentialDocument> {
    assertAvailable();
    let content: string;
    try {
      content = await fileSystem.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, credentials: {} };
      throw corrupted();
    }
    try {
      const document: unknown = JSON.parse(content);
      if (!isDocument(document)) throw corrupted();
      return document;
    } catch (error) {
      if (error instanceof Error && error.message === "SSH 凭据文件损坏") throw error;
      throw corrupted();
    }
  }

  async function writeDocument(document: CredentialDocument) {
    assertAvailable();
    await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
    await fileSystem.chmod(directory, 0o700);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fileSystem.writeFile(temporary, `${JSON.stringify(document)}\n`, { encoding: "utf8", mode: 0o600 });
      await fileSystem.rename(temporary, file);
      await fileSystem.chmod(file, 0o600);
    } catch (error) {
      await fileSystem.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  function mutate<T>(operation: () => Promise<T>) {
    const next = mutationQueue.then(operation, operation);
    mutationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  async function has(hostId: string, target: SshCredentialTarget) {
    const id = validateSshHostId(hostId);
    const expectedTarget = normalizeTarget(target);
    const document = await readDocument();
    const entry = document.credentials[id];
    return isCredentialRecord(entry) && sameTarget(entry.target, expectedTarget);
  }

  async function get(hostId: string, target: SshCredentialTarget) {
    const id = validateSshHostId(hostId);
    const expectedTarget = normalizeTarget(target);
    const document = await readDocument();
    const entry = document.credentials[id];
    if (!isCredentialRecord(entry) || !sameTarget(entry.target, expectedTarget)) return undefined;
    try {
      const password = safeStorage.decryptString(Buffer.from(entry.encrypted, "base64"));
      validatePassword(password);
      return password;
    } catch (error) {
      if (error instanceof Error && error.message === "SSH 部署密码无效") throw error;
      throw corrupted();
    }
  }

  async function set(hostId: string, password: string, target: SshCredentialTarget) {
    const id = validateSshHostId(hostId);
    if (typeof password !== "string") throw invalidPassword();
    validatePassword(password);
    const expectedTarget = normalizeTarget(target);
    return mutate(async () => {
      assertAvailable();
      const document = await readDocument();
      let encrypted: Buffer;
      try {
        encrypted = safeStorage.encryptString(password);
      } catch {
        throw unavailable();
      }
      document.credentials[id] = { encrypted: encrypted.toString("base64"), target: expectedTarget };
      await writeDocument(document);
      return true;
    });
  }

  async function remove(hostId: string) {
    const id = validateSshHostId(hostId);
    return mutate(async () => {
      const document = await readDocument();
      if (!Object.prototype.hasOwnProperty.call(document.credentials, id)) return false;
      delete document.credentials[id];
      await writeDocument(document);
      return true;
    });
  }

  return { has, get, set, remove };
}
