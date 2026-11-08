import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilesystemClaimLock } from '../../domain/backlog/claim.js';
import { createLocalEncryptedEvidenceStore, LocalEncryptedEvidenceStore, redactUtf8 } from './local-evidence-store.js';

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

  it.each(['ordinary diagnostic output', 'password=review-private-password'])('preserves restricted status when redacting %s', input => {
    const result = redactUtf8(Buffer.from(input), 'restricted');
    expect(result.redactionStatus).toBe('restricted');
    expect(Buffer.from(result.bytes).toString()).not.toContain('review-private-password');
  });

  it.each([
    'https://user:review-private-password@example.test/pr/1',
    'failed to publish https://user:review-private-password@example.test/pr/1; retry later',
    '{"url":"https://user:review-private-password@example.test/pr/1"}',
    'http://review-private-user@example.test/pr/1',
    'https://review%40private:review%3Apassword@example.test/pr/1',
  ])('removes URL userinfo from text: %s', input => {
    const result = redactUtf8(Buffer.from(input));
    const text = Buffer.from(result.bytes).toString();
    expect(text).toContain('example.test/pr/1');
    expect(text).not.toContain('review');
    expect(text).not.toContain('@');
    expect(result.redactionStatus).toBe('applied');
    if (input.startsWith('{')) expect(JSON.parse(text)).toEqual({ url: 'https://example.test/pr/1' });
  });
});

describe('persistent evidence store', () => {
  it.each([false, true])('initializes despite an expired legacy key claim, preserving any existing key: %s', async existing => {
    const home = await root();
    const directory = join(home, '.afk', 'evidence');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const keyPath = join(directory, 'encryption.key');
    const priorKey = randomBytes(32);
    if (existing) await fs.writeFile(keyPath, priorKey, { mode: 0o600 });
    const lock = new FilesystemClaimLock(directory);
    const lease = await lock.acquire({ key: 'observability/evidence/encryption-key', owner: 'expired-test-owner', ttlMs: 1 });
    expect(lease).not.toBeNull();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(Date.parse((await lock.inspect('observability/evidence/encryption-key'))!.expiresAt)).toBeLessThan(Date.now());
    const store = await createLocalEncryptedEvidenceStore(home);
    const persistedKey = await fs.readFile(keyPath);
    expect(persistedKey.byteLength).toBe(32);
    if (existing) expect(persistedKey).toEqual(priorKey);
    const ref = await store.put({ bytes: Buffer.from('proof'), mediaType: 'text/plain', classification: 'internal', redactionStatus: 'not_required' });
    expect(await (await createLocalEncryptedEvidenceStore(home)).get(ref)).toEqual(Buffer.from('proof'));
  }, 10_000);

  it('initializes one private key across concurrent factories and reopens encrypted evidence', async () => {
    const home = await root();
    const stores = await Promise.all(Array.from({ length: 4 }, () => createLocalEncryptedEvidenceStore(home)));
    const directory = join(home, '.afk', 'evidence');
    const key = join(directory, 'encryption.key');
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(key)).mode & 0o777).toBe(0o600);
    expect((await fs.readFile(key)).byteLength).toBe(32);
    const ref = await stores[0].put({ bytes: Buffer.from('password=private-value'), mediaType: 'text/plain', classification: 'internal', redactionStatus: 'not_required' });
    for (const store of [...stores, await createLocalEncryptedEvidenceStore(home)]) {
      expect(Buffer.from(await store.get(ref)).toString()).toBe('password=[redacted]');
    }
  });

  it.each(['root-symlink', 'parent-symlink', 'key-symlink', 'key-hardlink', 'bad-key', 'public-key'] as const)('rejects unsafe storage: %s', async kind => {
    const home = await root();
    const outside = await root();
    const directory = join(home, '.afk', 'evidence');
    const key = join(directory, 'encryption.key');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (kind === 'root-symlink' || kind === 'parent-symlink') {
      const path = kind === 'root-symlink' ? directory : join(home, '.afk');
      await fs.rm(path, { recursive: true });
      await fs.symlink(outside, path);
    } else if (kind === 'key-symlink' || kind === 'key-hardlink') {
      const target = join(outside, 'key');
      await fs.writeFile(target, randomBytes(32), { mode: 0o600 });
      if (kind === 'key-symlink') await fs.symlink(target, key);
      else await fs.link(target, key);
    } else {
      await fs.writeFile(key, randomBytes(kind === 'bad-key' ? 31 : 32), { mode: kind === 'public-key' ? 0o644 : 0o600 });
    }
    await expect(createLocalEncryptedEvidenceStore(home)).rejects.toThrow();
  });

  it.each(['symlink', 'hardlink'] as const)('rejects %s ciphertext on read and deduplicated put', async kind => {
    const home = await root();
    const store = await createLocalEncryptedEvidenceStore(home);
    const input = { bytes: Buffer.from('proof'), mediaType: 'text/plain', classification: 'internal' as const, redactionStatus: 'not_required' as const };
    const ref = await store.put(input);
    const path = join(store.root, `${ref.sha256}.bin`);
    const target = join(home, 'outside.bin');
    await fs.rename(path, target);
    if (kind === 'symlink') await fs.symlink(target, path);
    else await fs.link(target, path);
    await expect(store.get(ref)).rejects.toThrow();
    await expect(store.put(input)).rejects.toThrow();
  });
});
