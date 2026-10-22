import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function fixture(source: string, dependency = true, runtimeDependencies = {}) {
  const root = mkdtempSync(join(tmpdir(), 'afk-workspaces-'));
  roots.push(root);
  for (const [directory, manifest] of [
    ['apps/cli', { name: 'afk', dependencies: dependency ? { '@afk/runtime': 'workspace:*' } : {} }],
    ['packages/runtime', { name: '@afk/runtime', exports: { './execution': './dist/execution.js' }, dependencies: runtimeDependencies }],
  ] as const) {
    mkdirSync(join(root, directory, 'src'), { recursive: true });
    writeFileSync(join(root, directory, 'package.json'), JSON.stringify(manifest));
  }
  writeFileSync(join(root, 'apps/cli/src/index.ts'), source);
  return () => execFileSync(process.execPath, [resolve('scripts/check-workspace-imports.mjs'), root], { encoding: 'utf8', stdio: 'pipe' });
}

describe('workspace imports', () => {
  it('accepts declared public module imports', () => {
    expect(fixture("import { executeWorkItem } from '@afk/runtime/execution';")()).toContain('passed');
  });
  it('rejects relative imports into another workspace', () => {
    expect(fixture("import '../../../packages/runtime/src/execution.js';")).toThrow(/imports outside/);
  });
  it('rejects private package imports', () => {
    expect(fixture("import '@afk/runtime/src/execution.js';")).toThrow(/private package path/);
  });
  it('rejects undeclared workspace dependencies', () => {
    expect(fixture("import '@afk/runtime/execution';", false)).toThrow(/undeclared dependency/);
  });
  it('rejects shared packages depending on applications and cycles', () => {
    expect(fixture("import '@afk/runtime/execution';", true, { afk: 'workspace:*' })).toThrow(/must not depend on application|dependency cycle/);
  });
});
