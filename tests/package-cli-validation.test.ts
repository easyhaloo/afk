import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertNoBundledAgent } from '../scripts/package-cli-validation.mjs';

const temporaryDirectories: string[] = [];

async function createPackageTree(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'afk-cli-package-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe('CLI package validation', () => {
  it('allows Codex runtime implementation directories and their JavaScript files', async () => {
    const directory = await createPackageTree();
    const infrastructure = join(directory, 'dist/infrastructure/codex');
    const appServer = join(directory, 'dist/domain/agents/codex-app-server');

    await mkdir(infrastructure, { recursive: true });
    await mkdir(appServer, { recursive: true });
    await writeFile(join(infrastructure, 'turn-failure.js'), 'export {};');
    await writeFile(join(appServer, 'transport.js'), 'export {};');

    await expect(assertNoBundledAgent(directory)).resolves.toBeUndefined();
  });

  it.each(['codex', 'codex-linux-x64', 'claude', 'claude-code'])(
    'rejects a bundled executable named %s',
    async executableName => {
      const directory = await createPackageTree();
      const executable = join(directory, 'node_modules/.bin', executableName);

      await mkdir(join(directory, 'node_modules/.bin'), { recursive: true });
      await writeFile(executable, '#!/bin/sh\nexit 0\n');
      await chmod(executable, 0o755);

      await expect(assertNoBundledAgent(directory)).rejects.toThrow(executable);
    },
  );

  it('does not reject non-executable files solely because their name resembles an Agent CLI', async () => {
    const directory = await createPackageTree();
    const executableName = join(directory, 'dist/codex-runtime.js');

    await mkdir(join(directory, 'dist'), { recursive: true });
    await writeFile(executableName, 'export {};', { mode: 0o644 });

    await expect(assertNoBundledAgent(directory)).resolves.toBeUndefined();
  });
});
