import { afterAll, vi } from 'vitest';

const sandbox = await vi.hoisted(async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'afk-test-home-'));
  const previous = process.env.HOME;
  process.env.HOME = directory;
  return { cleanup: () => {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  } };
});

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = () => process.env.HOME!;
  return { ...actual, default: { ...actual, homedir }, homedir };
});

vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = () => process.env.HOME!;
  return { ...actual, default: { ...actual, homedir }, homedir };
});

afterAll(sandbox.cleanup);
