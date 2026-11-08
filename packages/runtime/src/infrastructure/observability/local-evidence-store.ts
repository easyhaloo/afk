import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceClassification, EvidenceRef, EvidenceStorePort } from '@afk/core';
import { FilesystemClaimLock } from '../../domain/backlog/claim.js';

const TEXTUAL_MEDIA_TYPE = /^(text\/|application\/(json|xml|javascript|typescript|x-yaml|yaml))/i;

export interface LocalEvidenceStoreOptions {
  root?: string;
  encryptionKey: Uint8Array;
}

export async function createLocalEncryptedEvidenceStore(homeDir = homedir()): Promise<LocalEncryptedEvidenceStore> {
  const parent = join(homeDir, '.afk');
  await ensurePrivateDirectory(parent, false);
  const root = join(parent, 'evidence');
  await ensurePrivateDirectory(root);
  const path = join(root, 'encryption.key');
  const readKey = async () => {
    const key = await readPrivateFile(path);
    if (key.byteLength !== 32) throw new Error('Invalid local evidence encryption key');
    return key;
  };
  try { return new LocalEncryptedEvidenceStore({ root, encryptionKey: await readKey() }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const lock = new FilesystemClaimLock(root);
  return lock.withExclusiveOperation('observability/evidence/encryption-key', async () => {
    let key: Uint8Array;
    try { key = await readKey(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      key = randomBytes(32);
      await writePrivateAtomic(path, key);
    }
    return new LocalEncryptedEvidenceStore({ root, encryptionKey: key });
  });
}

export class LocalEncryptedEvidenceStore implements EvidenceStorePort {
  readonly root: string;
  private readonly key: Uint8Array;

  constructor(options: LocalEvidenceStoreOptions) {
    if (options.encryptionKey.byteLength !== 32) throw new Error('evidence encryption key must be 32 bytes for AES-256-GCM');
    this.root = options.root ?? join(homedir(), '.afk', 'evidence');
    this.key = options.encryptionKey;
  }

  async put(input: {
    bytes: Uint8Array;
    mediaType: string;
    classification: EvidenceClassification;
    redactionStatus: EvidenceRef['redactionStatus'];
  }): Promise<EvidenceRef> {
    const normalized = TEXTUAL_MEDIA_TYPE.test(input.mediaType)
      ? redactUtf8(input.bytes, input.redactionStatus)
      : { bytes: input.bytes, redactionStatus: input.redactionStatus };
    const sha256 = createHash('sha256').update(normalized.bytes).digest('hex');
    const file = join(this.root, `${sha256}.bin`);
    await ensurePrivateDirectory(this.root);
    try {
      assertPrivateFile(await fs.lstat(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await writeEncrypted(file, normalized.bytes, this.key);
    }
    return {
      uri: `evidence://${sha256}`,
      sha256,
      mediaType: input.mediaType,
      classification: input.classification,
      redactionStatus: normalized.redactionStatus,
    };
  }

  async get(ref: EvidenceRef): Promise<Uint8Array> {
    if (!/^[a-f0-9]{64}$/.test(ref.sha256) || ref.uri !== `evidence://${ref.sha256}`) throw new Error('evidence URI and hash do not match');
    await ensurePrivateDirectory(this.root);
    const bytes = await readEncrypted(join(this.root, `${ref.sha256}.bin`), this.key);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== ref.sha256) throw new Error('evidence integrity mismatch');
    return bytes;
  }
}

export function redactUtf8(input: Uint8Array, initial: EvidenceRef['redactionStatus'] = 'not_required'): { bytes: Uint8Array; redactionStatus: EvidenceRef['redactionStatus'] } {
  const original = Buffer.from(input).toString('utf8');
  const redacted = original
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#"'<>\\]*@/gi, '$1')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[redacted:github-token]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted:github-token]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[redacted:api-key]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted:aws-access-key]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s'"`]+/gi, '$1[redacted]')
    .replace(/("(?:api[_-]?key|token|secret|password)"\s*:\s*")(?:\\.|[^"\\])*"/gi, '$1[redacted]"')
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, '$1[redacted]');
  return {
    bytes: Buffer.from(redacted, 'utf8'),
    redactionStatus: initial === 'restricted' || redacted === original ? initial : 'applied',
  };
}

async function writeEncrypted(path: string, bytes: Uint8Array, key: Uint8Array): Promise<void> {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  await writePrivateAtomic(path, Buffer.concat([Buffer.from('AFKE1'), iv, tag, encrypted]));
}

async function readEncrypted(path: string, key: Uint8Array): Promise<Uint8Array> {
  const contents = await readPrivateFile(path);
  if (contents.subarray(0, 5).toString('utf8') !== 'AFKE1') throw new Error('unsupported evidence envelope');
  const iv = contents.subarray(5, 17);
  const tag = contents.subarray(17, 33);
  const encrypted = contents.subarray(33);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

async function ensurePrivateDirectory(path: string, privateMode = true): Promise<void> {
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await fs.lstat(path);
  if (!metadata.isDirectory() || (process.getuid && metadata.uid !== process.getuid()) || (metadata.mode & 0o022)) throw new Error('Unsafe local evidence directory');
  if (privateMode && (metadata.mode & 0o777) !== 0o700) {
    const handle = await fs.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.chmod(0o700); } finally { await handle.close(); }
  }
}

function assertPrivateFile(metadata: Stats): void {
  if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600 || (process.getuid && metadata.uid !== process.getuid())) throw new Error('Unsafe local evidence file');
}

async function readPrivateFile(path: string): Promise<Buffer> {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { assertPrivateFile(await handle.stat()); return await handle.readFile(); }
  finally { await handle.close(); }
}

async function writePrivateAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { assertPrivateFile(await fs.lstat(path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await fs.rename(temporary, path);
    const directory = await fs.open(join(path, '..'), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.rm(temporary, { force: true }); }
}
