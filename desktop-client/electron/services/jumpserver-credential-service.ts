import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createMutex } from "../lib/async-mutex";

const CREDENTIAL_FILE = path.join(".config", "afk", "jumpserver-credentials.json");
const MAX_PASSWORD_BYTES = 4096;

type SecureStorage = {
  isEncryptionAvailable: () => boolean;
  encryptString: (value: string) => Buffer;
  decryptString: (value: Buffer) => string;
};

export type JumpserverCredentialTarget = {
  hostname: string;
  port: number;
  user: string;
};

type CredentialFileSystem = Pick<typeof fs, "chmod" | "mkdir" | "readFile" | "rename" | "rm" | "writeFile">;

type CredentialRecord = {
  encrypted: string;
  otpEncrypted?: string;
  bastionTarget: JumpserverCredentialTarget;
};

type CredentialDocument = {
  version: 1;
  credentials: Record<string, CredentialRecord>;
};

type JumpserverCredentialServiceDependencies = {
  home: string;
  safeStorage: SecureStorage;
  fileSystem?: CredentialFileSystem;
};

function unavailable() {
  return new Error("JumpServer 凭据安全存储不可用");
}

function corrupted() {
  return new Error("JumpServer 凭据文件损坏");
}

function invalidPassword() {
  return new Error("JumpServer 凭据参数无效");
}

function validatePassword(password: string) {
  if (!password || password.includes("\0") || password.includes("\r") || password.includes("\n") || Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) throw invalidPassword();
}

function validateOtpSecret(otpSecret: string) {
  if (otpSecret && (otpSecret.includes("\0") || otpSecret.includes("\r") || otpSecret.includes("\n") || Buffer.byteLength(otpSecret, "utf8") > MAX_PASSWORD_BYTES)) throw invalidPassword();
}

function normalizeTarget(target: JumpserverCredentialTarget): JumpserverCredentialTarget {
  if (!target || typeof target !== "object" || typeof target.hostname !== "string" || !target.hostname || typeof target.port !== "number" || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || typeof target.user !== "string" || !target.user) throw new Error("JumpServer 凭据参数无效");
  return { hostname: target.hostname, port: target.port, user: target.user };
}

function isTarget(value: unknown): value is JumpserverCredentialTarget {
  try {
    normalizeTarget(value as JumpserverCredentialTarget);
    return true;
  } catch {
    return false;
  }
}

function isCredentialRecord(value: unknown): value is CredentialRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return typeof input.encrypted === "string" && input.encrypted.length > 0 && isTarget(input.bastionTarget);
}

function isDocument(value: unknown): value is CredentialDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || !input.credentials || typeof input.credentials !== "object" || Array.isArray(input.credentials)) return false;
  return Object.values(input.credentials as Record<string, unknown>).every(isCredentialRecord);
}

// ponytail: predicate naming convention
export function isSameTarget(left: JumpserverCredentialTarget, right: JumpserverCredentialTarget) {
  return left.hostname === right.hostname && left.port === right.port && left.user === right.user;
}

export function createJumpserverCredentialStore({ home, safeStorage, fileSystem = fs }: JumpserverCredentialServiceDependencies) {
  const file = path.join(home, CREDENTIAL_FILE);
  const directory = path.dirname(file);
  const mutex = createMutex<void>();

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
      if (error instanceof Error && error.message === "JumpServer 凭据文件损坏") throw error;
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

  async function has(bastionId: string, target: JumpserverCredentialTarget) {
    const expectedTarget = normalizeTarget(target);
    const document = await readDocument();
    const entry = document.credentials[bastionId];
    return isCredentialRecord(entry) && isSameTarget(entry.bastionTarget, expectedTarget);
  }

  async function get(bastionId: string, target: JumpserverCredentialTarget) {
    const expectedTarget = normalizeTarget(target);
    const document = await readDocument();
    const entry = document.credentials[bastionId];
    if (!isCredentialRecord(entry) || !isSameTarget(entry.bastionTarget, expectedTarget)) return undefined;
    try {
      const password = safeStorage.decryptString(Buffer.from(entry.encrypted, "base64"));
      validatePassword(password);
      const result: { password: string; otpSecret?: string } = { password };
      if (entry.otpEncrypted) {
        const otpSecret = safeStorage.decryptString(Buffer.from(entry.otpEncrypted, "base64"));
        validateOtpSecret(otpSecret);
        result.otpSecret = otpSecret;
      }
      return result;
    } catch (error) {
      if (error instanceof Error && error.message === "JumpServer 凭据参数无效") throw error;
      throw corrupted();
    }
  }

  async function set(bastionId: string, password: string, target: JumpserverCredentialTarget, otpSecret?: string) {
    if (typeof password !== "string" || !password) throw invalidPassword();
    validatePassword(password);
    if (otpSecret !== undefined && otpSecret !== "") validateOtpSecret(otpSecret);
    const expectedTarget = normalizeTarget(target);
    return mutex.run(async () => {
      assertAvailable();
      const document = await readDocument();
      let encrypted: Buffer;
      let otpEncrypted: string | undefined;
      try {
        encrypted = safeStorage.encryptString(password);
        if (otpSecret && otpSecret !== "") {
          otpEncrypted = safeStorage.encryptString(otpSecret).toString("base64");
        }
      } catch {
        throw unavailable();
      }
      document.credentials[bastionId] = {
        encrypted: encrypted.toString("base64"),
        bastionTarget: expectedTarget,
        ...(otpEncrypted ? { otpEncrypted } : {}),
      };
      await writeDocument(document);
      return true;
    });
  }

  async function remove(bastionId: string) {
    return mutex.run(async () => {
      const document = await readDocument();
      if (!Object.prototype.hasOwnProperty.call(document.credentials, bastionId)) return false;
      delete document.credentials[bastionId];
      await writeDocument(document);
      return true;
    });
  }

  return { has, get, set, remove };
}

