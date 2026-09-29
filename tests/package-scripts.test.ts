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
    const packageJson = JSON.parse(readFileSync(join(repositoryRoot, 'desktop-client/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const makefile = readFileSync(join(repositoryRoot, 'Makefile'), 'utf8');

    expect(makefile).toContain('desktop-dev:\n\tpnpm --filter afk-control-electron start');
    expect(packageJson.scripts?.start).toBe('bash scripts/start.sh');
  });

  it('cleans up the previous desktop development stack before starting a new one', () => {
    const startScript = readFileSync(join(repositoryRoot, 'desktop-client/scripts/start.sh'), 'utf8');

    expect(startScript).toContain('dev:raw');
    expect(startScript).toContain('tsc -p tsconfig.electron.json --watch');
    expect(startScript).toContain('electron .');
    expect(startScript).toContain('detached: true');
    expect(startScript).toContain('stop_dev_processes KILL');
  });

  it('builds and packages a standalone inventory runner for clean desktop installs', () => {
    const packageJson = JSON.parse(readFileSync(join(repositoryRoot, 'desktop-client/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
      build?: { files?: string[] };
    };

    expect(packageJson.scripts?.['build:inventory']).toBe('node scripts/build-inventory-runner.mjs');
    expect(packageJson.scripts?.['build:main']).toContain('pnpm build:inventory');
    expect(packageJson.build?.files).toContain('dist-electron/cli/**');
  });
});
