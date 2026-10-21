import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The profile is part of every audit event's identity, so the entry
 * points that write one have to agree on what it is. They each spelled
 * out the same fallback, and a blank `AFK_PROFILE=` left the audit
 * trail under a profile no reader could name.
 *
 * The fallback lives in one place now. This check keeps the other
 * spellings from coming back.
 */
const PUBLISHED_ROOTS = [
  'src',
  'packages/afk-core/src',
  'packages/afk-application/src',
  'packages/afk-infrastructure/src',
  'packages/afk-execution/src',
  'packages/afk-workflow-graph/src',
  'desktop-client/electron',
  'desktop-client/shared',
];

const FALLBACK = /AFK_PROFILE\s*(?:\?\?|\|\|)/g;

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (path.endsWith('.ts') && !path.endsWith('.d.ts') && !path.includes('.test.')) found.push(path);
  }
  return found;
}

describe('the observation profile', () => {
  it('has one fallback', () => {
    const offenders: string[] = [];

    for (const root of PUBLISHED_ROOTS) {
      const directory = fileURLToPath(new URL(`../../${root}/`, import.meta.url));
      for (const file of sourceFiles(directory)) {
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(FALLBACK)) {
          const line = source.slice(0, match.index).split('\n').length;
          offenders.push(`${relative(directory, file)}:${line}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
