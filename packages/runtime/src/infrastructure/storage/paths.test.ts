import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { inventoryNamespace, localStoragePaths } from './paths.js';

describe('shared storage paths', () => {
  it('uses the same user-level root independently of the execution workspace', () => {
    expect(localStoragePaths().root).toBe(join(homedir(), '.afk', 'storage'));
    expect(localStoragePaths('temporary-data').config).toBe(join(resolve('temporary-data'), 'local-config.sqlite'));
  });

  it('canonicalizes verified identity sets and isolates accounts and hosts', () => {
    const github = { platform: 'github' as const, host: 'https://GITHUB.COM/', accountId: '123' };
    const gitlab = { platform: 'gitlab' as const, host: 'gitlab.example.invalid', accountId: '456' };
    expect(inventoryNamespace([github, gitlab])).toBe(inventoryNamespace([gitlab, { ...github, host: 'github.com' }]));
    expect(inventoryNamespace([github])).not.toBe(inventoryNamespace([{ ...github, accountId: '124' }]));
    expect(inventoryNamespace([gitlab])).not.toBe(inventoryNamespace([{ ...gitlab, host: 'other.invalid' }]));
    expect(() => inventoryNamespace([])).toThrow(/identity/i);
    expect(() => inventoryNamespace([{ ...github, accountId: '' }])).toThrow(/identity/i);
    expect(() => inventoryNamespace([{ ...github, host: 'https://example.invalid/path' }])).toThrow(/host/i);
  });
});
