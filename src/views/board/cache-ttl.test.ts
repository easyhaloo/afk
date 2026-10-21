import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function sourcesIn(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...sourcesIn(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

describe('the board cache', () => {
  it('declares the detail freshness window once', () => {
    // The disk cache and the memory cache in front of it are one cache
    // with two tiers. The tier in front used to carry its own copy of
    // the window, and a minute in one tier and two in the other serves a
    // stale detail for longer than the cache says it does.
    const declarations = sourcesIn(join(process.cwd(), 'src', 'views', 'board'))
      .flatMap(file => {
        const source = readFileSync(file, 'utf8');
        return [...source.matchAll(/const\s+DETAIL_TTL_MS\s*=/g)].map(() => file);
      });
    expect(declarations).toHaveLength(1);
  });
});
