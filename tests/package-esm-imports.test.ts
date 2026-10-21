import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../src/cli/command-registry.js';

/**
 * The published packages are ESM: node resolves a relative specifier
 * exactly as it is written, so an import without its `.js` extension
 * names a module that cannot be loaded.
 *
 * The test runner and the desktop bundle resolve both forms, which is why
 * this break went unnoticed: `afk run`, `afk graph` and `afk isolate`
 * failed in the built package - with ERR_MODULE_NOT_FOUND - while every
 * test passed.
 */
const PUBLISHED_ROOTS = [
  'src',
  'packages/afk-core/src',
  'packages/afk-application/src',
  'packages/afk-infrastructure/src',
  'packages/afk-execution/src',
  'packages/afk-workflow-graph/src',
];

const RELATIVE_SPECIFIER = /(?:from\s+|import\s*\(\s*|import\s+)['"](\.[^'"]*)['"]/g;

/** The built packages, as they are published. */
const PUBLISHED_DISTS = [
  'packages/afk-core/dist',
  'packages/afk-application/dist',
  'packages/afk-infrastructure/dist',
  'packages/afk-execution/dist',
  'packages/afk-workflow-graph/dist',
];

/** Every command the registry advertises, minus the hidden alias. */
const COMMAND_NAMES = COMMANDS.flatMap(entry => entry.names).filter(name => name !== '__complete');

function sourceFiles(directory: string, extension = '.ts'): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path, extension));
    else if (path.endsWith(extension) && !path.endsWith('.d.ts')) found.push(path);
  }
  return found;
}

describe('published package imports', () => {
  it.each(PUBLISHED_ROOTS)('%s names its relative imports with the extension node needs', root => {
    const directory = fileURLToPath(new URL(`../${root}/`, import.meta.url));
    const offenders: string[] = [];

    for (const file of sourceFiles(directory)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(RELATIVE_SPECIFIER)) {
        const specifier = match[1];
        if (specifier.endsWith('.js') || specifier.endsWith('.json')) continue;
        // A type query (`typeof import('...')`) is a type position, not an
        // import statement: it never reaches the emitted module.
        const before = source.slice(0, match.index);
        if (/\btypeof\s+$/.test(before)) continue;
        const line = before.split('\n').length;
        offenders.push(`${relative(directory, file)}:${line} -> ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('the built CLI', () => {
  it('loads every command it advertises', () => {
    // The source scan above catches the one way this breaks; this catches
    // the shape of it. `afk run`, `afk graph` and `afk isolate` failed
    // with ERR_MODULE_NOT_FOUND in the built package while every test
    // passed - the test runner and the desktop bundle resolve imports the
    // node runtime does not.
    const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
    const broken: string[] = [];

    for (const name of COMMAND_NAMES) {
      const result = spawnSync(process.execPath, [cli, name, '--help'], { encoding: 'utf8' });
      const output = `${result.stdout}${result.stderr}`;
      if (output.includes('ERR_MODULE_NOT_FOUND')) broken.push(`${name}: ${output.split('\n')[0]}`);
    }

    expect(broken).toEqual([]);
  });
});

describe('the published packages', () => {
  it('ships exactly the modules the source says', () => {
    // `tsc` overwrites the files it emits and leaves everything else
    // alone, so a module that moved keeps its old copy in dist/ unless the
    // build cleans it. The published package then ships a file that
    // points at a path that no longer exists - the resource registry once
    // did, and loading it failed with ERR_MODULE_NOT_FOUND.
    //
    // The check is on the file list rather than on loading: the test
    // runner resolves imports the node runtime does not, so a load check
    // here would pass a module that node cannot load.
    const stale: string[] = [];

    for (const root of PUBLISHED_DISTS) {
      const directory = fileURLToPath(new URL(`../${root}/`, import.meta.url));
      const source = fileURLToPath(new URL(`../${root.replace('/dist', '/src')}/`, import.meta.url));
      for (const file of sourceFiles(directory, '.js')) {
        const counterpart = join(source, relative(directory, file).replace(/\.js$/, '.ts'));
        if (!existsSync(counterpart)) stale.push(relative(directory, file));
      }
    }

    expect(stale).toEqual([]);
  });
});
