import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILD_STAMP_FILE, buildSources } from '../scripts/build-sources.mjs';

/**
 * A package's dist is what the rest of the workspace loads.
 *
 * The root's own typecheck and tests import the packages by their built
 * output, so a dist that was built from older sources answers for code
 * that is no longer there — and a green run says nothing about the
 * source. A build that was asked for under the wrong package name exits
 * zero without building anything, so the gap between source and output
 * is silent unless something compares the two.
 */
const PACKAGES = ['afk-core', 'afk-application', 'afk-infrastructure', 'afk-execution', 'afk-workflow-graph'];

describe('the built output is the current source', () => {
  it('builds the root package from the sources on disk', () => {
    // The root's own dist is what the ESM import test loads, and a dist
    // left over from an earlier source fails that test with a message
    // about a missing module rather than about the build being stale.
    assertFresh(resolve('.'), 'the root package');
  });

  for (const name of PACKAGES) {
    it(`builds @afk/${name} from the sources on disk`, () => {
      assertFresh(resolve('packages', name), `@afk/${name}`);
    });
  }
});

function assertFresh(packageDirectory: string, label: string): void {
  const distDirectory = resolve(packageDirectory, 'dist');
  // A clean checkout has no build output at all. That is not stale, it is
  // unbuilt, and the build that runs before the tests makes it.
  if (!existsSync(distDirectory)) return;

  const stampPath = resolve(distDirectory, BUILD_STAMP_FILE);
  expect(
    existsSync(stampPath),
    `${label} has a dist but no record of what it was built from; rebuild it with pnpm build`,
  ).toBe(true);

  const recorded = JSON.parse(readFileSync(stampPath, 'utf8')) as { files: Record<string, string> };
  const current = buildSources(packageDirectory);

  const changed = Object.keys({ ...recorded.files, ...current })
    .filter(file => recorded.files[file] !== current[file]);
  expect(
    changed,
    `${label} was built from sources that have since changed (${changed.join(', ') || 'the source set differs'}); rebuild it with pnpm build`,
  ).toEqual([]);
}
