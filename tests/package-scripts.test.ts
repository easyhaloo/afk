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

  it('keeps desktop development attached while preserving the background start command', () => {
    const packageJson = JSON.parse(readFileSync(join(repositoryRoot, 'desktop-client/package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.dev).toBe('pnpm run dev:raw');
    expect(packageJson.scripts?.start).toBe('bash scripts/start.sh');
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
