import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * "Is this process still there?" had six answers in this repository, and
 * they disagreed: one read a process that could not be signalled as
 * gone, another as alive, a third as unknown, and a fourth threw. Each
 * copy decided on its own what an inconclusive probe meant, so the same
 * run could be reported as finished in one view and running in another.
 *
 * The probe lives in one place now. This check keeps the other copies
 * from coming back.
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

const PROBE = /process\.kill\(\s*[A-Za-z_][\w.]*\s*,\s*0\s*\)/g;

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    // A test that probes a process it started is doing the right thing.
    else if (path.endsWith('.ts') && !path.endsWith('.d.ts') && !path.includes('.test.')) found.push(path);
  }
  return found;
}

describe('the process liveness probe', () => {
  it('is written in one place', () => {
    const offenders: string[] = [];

    for (const root of PUBLISHED_ROOTS) {
      const directory = fileURLToPath(new URL(`../../${root}/`, import.meta.url));
      for (const file of sourceFiles(directory)) {
        if (file.endsWith(`${'io'}/process.ts`)) continue;
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(PROBE)) {
          const line = source.slice(0, match.index).split('\n').length;
          offenders.push(`${relative(directory, file)}:${line}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
