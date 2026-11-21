import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareVersions, findManagedInstallPrefix, parseLatestRelease } from './update.js';

describe('AFK update version handling', () => {
  it('updates the invoked prefix inside its selected profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'update-profile-'));
    try {
      const profile = join(root, 'profile');
      const binaries = [];
      for (const version of ['old', 'active']) {
        const dist = join(profile, 'cli/versions', version, 'dist');
        const prefix = join(root, version);
        await mkdir(dist, { recursive: true });
        await mkdir(prefix);
        await writeFile(join(dist, 'index.js'), '');
        await symlink(join(dist, 'index.js'), join(prefix, 'afk'));
        binaries.push(prefix);
      }
      const entry = join(binaries[1]!, 'afk');
      expect(await findManagedInstallPrefix(entry, binaries.join(delimiter), profile)).toBe(binaries[1]);
      expect(await findManagedInstallPrefix(join(profile, 'cli/versions/active/dist/index.js'), binaries.join(delimiter), profile)).toBe(binaries[1]);
      await expect(findManagedInstallPrefix(entry, binaries.join(delimiter), root)).rejects.toThrow('installation profile');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['0.1.10', '0.1.2', 1],
    ['1.0.0', '0.99.99', 1],
    ['0.1.2', '0.1.2', 0],
    ['0.1.1', '0.1.2', -1],
  ])('compares %s with %s', (left, right, expected) => {
    expect(compareVersions(left, right)).toBe(expected);
  });

  it('extracts a stable version from the latest CLI release tag', () => {
    expect(parseLatestRelease({ tag_name: 'cli-v1.2.3' })).toEqual({
      tag: 'cli-v1.2.3',
      version: '1.2.3',
    });
  });

  it.each([
    null,
    {},
    { tag_name: 'v1.2.3' },
    { tag_name: 'cli-v1.2' },
    { tag_name: 'cli-vlatest' },
    { tag_name: 123 },
  ])('rejects invalid latest release metadata: %j', payload => {
    expect(() => parseLatestRelease(payload)).toThrow();
  });
});
