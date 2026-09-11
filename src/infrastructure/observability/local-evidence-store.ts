import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EvidenceClassification, EvidenceRef } from '../../core/events';
import type { EvidenceStorePort } from '../../core/ports';

const TEXTUAL_MEDIA_TYPE = /^(text\/|application\/(json|xml|javascript|typescript|x-yaml|yaml))/i;

export interface LocalEvidenceStoreOptions {
  root?: string;
  encryptionKey: Uint8Array;
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
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      await fs.access(file);
    } catch {
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
    const expected = ref.uri.replace('evidence://', '');
    if (expected !== ref.sha256) throw new Error('evidence URI and hash do not match');
    const bytes = await readEncrypted(join(this.root, `${ref.sha256}.bin`), this.key);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== ref.sha256) throw new Error('evidence integrity mismatch');
    return bytes;
  }
}

export function redactUtf8(input: Uint8Array, initial: EvidenceRef['redactionStatus'] = 'not_required'): { bytes: Uint8Array; redactionStatus: EvidenceRef['redactionStatus'] } {
  const original = Buffer.from(input).toString('utf8');
  const redacted = original
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[redacted:github-token]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted:github-token]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[redacted:api-key]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted:aws-access-key]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s'"`]+/gi, '$1[redacted]')
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, '$1[redacted]');
  return {
    bytes: Buffer.from(redacted, 'utf8'),
    redactionStatus: redacted === original ? initial : 'applied',
  };
}

async function writeEncrypted(path: string, bytes: Uint8Array, key: Uint8Array): Promise<void> {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  await fs.writeFile(temporary, Buffer.concat([Buffer.from('AFKE1'), iv, tag, encrypted]), { mode: 0o600 });
  await fs.rename(temporary, path);
}

async function readEncrypted(path: string, key: Uint8Array): Promise<Uint8Array> {
  const contents = await fs.readFile(path);
  if (contents.subarray(0, 5).toString('utf8') !== 'AFKE1') throw new Error('unsupported evidence envelope');
  const iv = contents.subarray(5, 17);
  const tag = contents.subarray(17, 33);
  const encrypted = contents.subarray(33);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}
