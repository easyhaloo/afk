import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const guard = resolve('scripts/architecture-guard.mjs');
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(source: string, extraFiles: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'afk-architecture-'));
  directories.push(directory);
  const root = join(directory, 'src');
  mkdirSync(join(root, 'lib'), { recursive: true });
  mkdirSync(join(root, 'cli'), { recursive: true });
  writeFileSync(join(root, 'lib', 'legacy.ts'), 'export const legacy = true;\n');
  writeFileSync(join(root, 'cli', 'entry.ts'), source);
  for (const [filename, contents] of Object.entries(extraFiles)) {
    mkdirSync(resolve(root, filename, '..'), { recursive: true });
    writeFileSync(resolve(root, filename), contents);
  }
  const baseline = join(directory, 'baseline.json');
  writeFileSync(baseline, JSON.stringify({
    legacyFiles: ['lib/legacy.ts'],
    legacyImports: { 'cli/entry.ts -> lib/legacy.ts': 1 },
    legacyPatterns: {},
  }));
  const run = () => {
    try {
      return execFileSync(process.execPath, [guard, '--root', root, '--baseline', baseline], { encoding: 'utf8' });
    } catch (error) {
      return (error as { stderr: Buffer }).stderr.toString();
    }
  };
  return { run, root, baseline };
}

describe('architecture guard migration baseline', () => {
  it('accepts reviewed legacy files and imports', () => {
    expect(fixture("import { legacy } from '../lib/legacy';\nconsole.log(legacy);\n").run()).toContain('Architecture guard passed');
  });

  it('rejects newly added legacy files and imports', () => {
    const addedFile = fixture("import { legacy } from '../lib/legacy';\n", { 'lib/new.ts': 'export const value = 1;\n' });
    expect(addedFile.run()).toContain('unapproved legacy file: lib/new.ts');
    const addedImport = fixture("import { legacy } from '../lib/legacy';\nimport '../lib/legacy';\n");
    expect(addedImport.run()).toContain('unapproved legacy import: cli/entry.ts -> lib/legacy.ts');
  });

  it('counts template-literal dynamic imports of legacy files', () => {
    const addedImport = fixture("import { legacy } from '../lib/legacy';\nvoid import(`../lib/legacy.js`);\n");
    expect(addedImport.run()).toContain('unapproved legacy import: cli/entry.ts -> lib/legacy.ts');
  });

  it('rejects client-factory imports with a .js extension', () => {
    const addedImport = fixture("import { legacy } from '../lib/legacy';\nimport { createClient } from './client-factory.js';\n", {
      'cli/client-factory.ts': 'export const createClient = () => true;\n',
    });
    expect(addedImport.run()).toContain('legacy client-factory import remains');
  });

  it('rejects new .js client-factory imports in grandfathered legacy files', () => {
    const addedImport = fixture("import { legacy } from '../lib/legacy';\n", {
      'cli/client-factory.ts': 'export const createClient = () => true;\n',
      'lib/legacy.ts': "import { createClient } from '../cli/client-factory.js';\nexport const legacy = createClient();\n",
    });
    expect(addedImport.run()).toContain('unapproved legacy pattern: legacy client-factory import remains');
  });

  it('rejects generic records with spaces after the angle bracket', () => {
    const addedPattern = fixture("import { legacy } from '../lib/legacy';\nexport type Extra = Record< string, unknown >;\n");
    expect(addedPattern.run()).toContain('generic Record<string, unknown> used in source');
  });

  it('rejects new forbidden patterns within a grandfathered legacy file', () => {
    const addedPattern = fixture("import { legacy } from '../lib/legacy';\n", {
      'lib/legacy.ts': 'export type Extra = Record<string, unknown>;\n',
    });
    expect(addedPattern.run()).toContain('unapproved legacy pattern');
  });

  it('requires the baseline to shrink when approved debt is removed', () => {
    const removedImport = fixture('export const current = true;\n');
    expect(removedImport.run()).toContain('stale legacy import baseline');
  });
});

describe('architecture guard CI', () => {
  it('runs the architecture check in CI', () => {
    expect(readFileSync(resolve('.github/workflows/ci.yml'), 'utf8')).toMatch(/run: pnpm architecture:check/);
  });
});
