import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);

describe('CLI version metadata', () => {
  it.each(['--version', '-V'])('reports the package version for %s', async flag => {
    const manifest = JSON.parse(await readFile('apps/cli/package.json', 'utf8')) as { version: string };
    const { stdout } = await exec('pnpm', ['--filter', 'afk', 'exec', 'tsx', 'src/index.ts', flag]);
    expect(stdout.trim()).toBe(manifest.version);
  });
});
