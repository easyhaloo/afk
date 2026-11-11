import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CI product dependency selection', () => {
  it.each([
    ['apps/cli/src/commands/plugin.ts', true, true],
    ['apps/desktop/tests/e2e/_helpers/learning.ts', false, true],
    ['packages/runtime/src/application/plugins/learning.ts', true, true],
    ['.github/workflows/ci.yml', true, true],
    ['docs/architecture/plugins.md', false, false],
  ] as const)('selects shared and Desktop checks for %s', (changedFile, shared, desktop) => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    const start = workflow.indexOf('docs=false');
    const end = workflow.indexOf('echo "Detected areas:"', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const directory = mkdtempSync(join(tmpdir(), 'ci-selection-'));
    try {
      const output = join(directory, 'outputs');
      execFileSync('/bin/bash', ['--noprofile', '--norc', '-euo', 'pipefail', '-c', workflow.slice(start, end)],
        { env: { changed_files: changedFile, GITHUB_OUTPUT: output } });
      const flags = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => line.split('=')));
      expect(flags.shared).toBe(String(shared));
      expect(flags.desktop).toBe(String(desktop));
      expect(flags.desktop_e2e).toBe(String(desktop));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
