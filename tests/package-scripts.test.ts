import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('package test scripts', () => {
  it('builds the production dashboard before running its PTY tests', () => {
    const packageJson = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.pretest).toBe('npm run build');
  });

  it('starts desktop development through the background launcher', () => {
    const packageJson = JSON.parse(readFileSync(join(repositoryRoot, 'apps/desktop/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const makefile = readFileSync(join(repositoryRoot, 'Makefile'), 'utf8');

    expect(makefile).toContain('desktop-dev:\n\tpnpm --filter afk-control-electron start');
    expect(packageJson.scripts?.start).toBe('bash scripts/start.sh');
  });

  it('cleans up the previous desktop development stack before starting a new one', () => {
    const startScript = readFileSync(join(repositoryRoot, 'apps/desktop/scripts/start.sh'), 'utf8');

    expect(startScript).toContain('dev:raw');
    // The dev stack's process matcher must recognise whatever actually runs the
    // main-process rebuild, otherwise stopping the stack leaves an orphan watcher.
    expect(startScript).toContain('scripts/build-main.mjs --watch');
    expect(startScript).not.toContain('tsc -p tsconfig.electron.json --watch');
    expect(startScript).toContain('electron .');
    expect(startScript).toContain('detached: true');
    expect(startScript).toContain('stop_dev_processes KILL');
  });

  it('builds the in-process inventory provider instead of packaging the CLI runner', () => {
    const packageJson = JSON.parse(readFileSync(join(repositoryRoot, 'apps/desktop/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
      build?: { files?: string[] };
    };

    expect(packageJson.scripts?.['build:main']).toContain('node scripts/build-provider-inventory.mjs');
    const inventoryBuild = readFileSync(join(repositoryRoot, 'apps/desktop/scripts/build-provider-inventory.mjs'), 'utf8');
    expect(inventoryBuild).toContain('dist-electron/provider-inventory.cjs');
    // Electron main and the @afk/* packages are both ESM now, so the use cases
    // are imported directly. Guard against re-introducing a CommonJS bridge.
    expect(inventoryBuild).not.toContain('application.cjs');
    expect(packageJson.scripts?.['build:inventory']).toBeUndefined();
    expect(packageJson.build?.files).toContain('dist-electron/**');
    expect(packageJson.build?.files).not.toContain('dist-electron/cli/**');
  });

  it('bundles the workspace packages into the packaged Electron main', () => {
    const packageJson = JSON.parse(readFileSync(join(repositoryRoot, 'apps/desktop/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const mainBuild = readFileSync(join(repositoryRoot, 'apps/desktop/scripts/build-main.mjs'), 'utf8');

    expect(packageJson.scripts?.['build:main']).toContain('node scripts/build-main.mjs');
    expect(mainBuild).toContain('bundle: true');
    // pnpm workspace deps are symlinks; electron-builder does not follow them
    // into the asar. If @afk/* were external, the packaged main could not
    // resolve them and the app would fail to start.
    expect(mainBuild).not.toMatch(/external:\s*\[[^\]]*@afk/);
    expect(mainBuild).toMatch(/external:\s*\[[^\]]*'electron'/);
    // Inlined at build time, so they are not runtime dependencies.
    expect(Object.keys(packageJson.dependencies ?? {})).not.toContain('@afk/application');
    expect(Object.keys(packageJson.devDependencies ?? {})).toContain('@afk/application');
  });
});
