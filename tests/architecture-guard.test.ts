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
  const run = (...args: string[]) => {
    try {
      return execFileSync(process.execPath, [guard, '--root', root, '--baseline', baseline, ...args], { encoding: 'utf8' });
    } catch (error) {
      return (error as { stderr: Buffer }).stderr.toString();
    }
  };
  return { run, root, baseline };
}

function packageFixture({
  coreSource = 'export type CoreValue = string;\n',
  applicationSource = "import type { CoreValue } from '@afk/core';\nexport type ApplicationValue = CoreValue;\n",
  corePackage = { dependencies: {} },
  applicationPackage = { dependencies: { '@afk/core': 'workspace:*' } },
  includeCore = true,
  includeApplication = true,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'afk-architecture-packages-'));
  directories.push(directory);
  const root = join(directory, 'src');
  mkdirSync(join(root, 'cli'), { recursive: true });
  writeFileSync(join(root, 'cli', 'entry.ts'), 'export const current = true;\n');
  const baseline = join(directory, 'baseline.json');
  writeFileSync(baseline, JSON.stringify({ legacyFiles: [], legacyImports: {}, legacyPatterns: {} }));

  const packageRoots = {
    core: join(directory, 'packages', 'afk-core'),
    application: join(directory, 'packages', 'afk-application'),
  };
  if (includeCore) {
    mkdirSync(join(packageRoots.core, 'src'), { recursive: true });
    writeFileSync(join(packageRoots.core, 'src', 'index.ts'), coreSource);
    writeFileSync(join(packageRoots.core, 'package.json'), JSON.stringify({ name: '@afk/core', ...corePackage }));
  }
  if (includeApplication) {
    mkdirSync(join(packageRoots.application, 'src'), { recursive: true });
    writeFileSync(join(packageRoots.application, 'src', 'index.ts'), applicationSource);
    writeFileSync(join(packageRoots.application, 'package.json'), JSON.stringify({ name: '@afk/application', ...applicationPackage }));
  }

  const run = (...args: string[]) => {
    try {
      const command = [
        guard,
        '--root',
        root,
        '--baseline',
        baseline,
        '--check-packages',
        '--core-root',
        packageRoots.core,
        '--application-root',
        packageRoots.application,
        ...args,
      ];
      return execFileSync(process.execPath, command, { encoding: 'utf8' });
    } catch (error) {
      return (error as { stderr: Buffer }).stderr.toString();
    }
  };
  return { run, packageRoots };
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

  it('reports a repeated legacy import only once', () => {
    const repeatedImport = fixture("import { legacy } from '../lib/legacy';\nimport '../lib/legacy';\n");
    const output = repeatedImport.run();
    expect(output.match(/unapproved legacy import: cli\/entry\.ts -> lib\/legacy\.ts/g)).toHaveLength(1);
    expect(output).not.toContain('stale legacy import baseline');
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
    expect(readFileSync(resolve('.github/workflows/ci.yml'), 'utf8')).toMatch(/run: pnpm architecture:check --check-packages/);
  });
});

describe('architecture guard package boundaries', () => {
  it('accepts pure core and application packages with the allowed dependency direction', () => {
    expect(packageFixture().run()).toContain('Architecture guard passed');
  });

  it('rejects Node.js and Electron imports from core', () => {
    const result = packageFixture({
      coreSource: "import { readFile } from 'node:fs/promises';\nimport { app } from 'electron/main';\nexport const value = { readFile, app, document };\n",
    });
    const output = result.run();
    expect(output).toContain("core package must not depend on 'node:fs/promises'");
    expect(output).toContain("core package must not depend on 'electron/main'");
    expect(output).toContain("core package must not use DOM global 'document'");
  });

  it('rejects concrete infrastructure imports and dependencies from application', () => {
    const result = packageFixture({
      applicationSource: "import { simpleGit } from 'simple-git';\nexport const value = simpleGit;\n",
      applicationPackage: { dependencies: { '@afk/core': 'workspace:*', 'simple-git': '^3.0.0' } },
    });
    const output = result.run();
    expect(output).toContain("application package must not depend on 'simple-git'");
    expect(output.match(/application package must not depend on 'simple-git'/g)).toHaveLength(1);
  });

  it('rejects package imports that point outside the package boundary', () => {
    const result = packageFixture({
      coreSource: "import { concrete } from '../../outside';\nexport { concrete };\n",
    });
    writeFileSync(join(result.packageRoots.core, '..', 'outside.ts'), 'export const concrete = true;\n');
    const output = result.run();
    expect(output).toContain('core package must not import outside its package root');
  });

  it('reports explicitly missing package roots without crashing', () => {
    const result = packageFixture({ includeApplication: false });
    const output = result.run('--require-packages');
    expect(output).toContain(`Missing application package root: ${result.packageRoots.application}`);
    expect(output.match(/Missing application package root:/g)).toHaveLength(1);
  });

  it('reports optional missing package roots clearly when package checks are enabled', () => {
    const result = packageFixture({ includeApplication: false });
    const output = result.run();
    expect(output).toContain(`Skipped optional package root: ${result.packageRoots.application}`);
  });
});
