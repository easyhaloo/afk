import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalEncryptedEvidenceStore, redactUtf8 } from './local-evidence-store';

const roots: string[] = [];

async function root(): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), 'afk-evidence-'));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => fs.rm(path, { recursive: true, force: true })));
});

describe('LocalEncryptedEvidenceStore', () => {
  it('redacts known credentials before encryption and verifies content on read', async () => {
    const path = await root();
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const store = new LocalEncryptedEvidenceStore({ root: path, encryptionKey: randomBytes(32) });
    const ref = await store.put({
      bytes: Buffer.from(`GITHUB_TOKEN=${secret}\nAuthorization: Bearer ${secret}\n`, 'utf8'),
      mediaType: 'text/plain',
      classification: 'sensitive',
      redactionStatus: 'not_required',
    });

    expect(ref.redactionStatus).toBe('applied');
    const roundTrip = Buffer.from(await store.get(ref)).toString('utf8');
    expect(roundTrip).toContain('[redacted]');
    expect(roundTrip).not.toContain(secret);

    const raw = await fs.readFile(join(path, `${ref.sha256}.bin`), 'utf8');
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain('[redacted]');
  });

  it('marks text unchanged when no recognized secret requires redaction', () => {
    const result = redactUtf8(Buffer.from('ordinary diagnostic output', 'utf8'));
    expect(Buffer.from(result.bytes).toString('utf8')).toBe('ordinary diagnostic output');
    expect(result.redactionStatus).toBe('not_required');
  });
});
