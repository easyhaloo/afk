import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { BACKLOG_CONTEXT_PATH, prepareManagedBacklogContext } from './backlog-context.js';

const item = { id: '1', title: 'Issue', description: 'Acceptance criteria' };
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'managed-backlog-context-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('releases only the current phase copy and leaves existing files intact', async () => {
  await mkdir(join(root, '.afk'));
  const existing = join(root, BACKLOG_CONTEXT_PATH);
  await writeFile(existing, 'already here');
  await using first = await prepareManagedBacklogContext(root, item);
  await using second = await prepareManagedBacklogContext(root, item);
  expect(first!.path).not.toBe(second!.path);
  await first!.release();
  await expect(readFile(join(root, first!.path))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(root, second!.path), 'utf8')).toContain(item.description);
  expect(await readFile(existing, 'utf8')).toBe('already here');
});

it.each(['edited', 'replaced'] as const)('preserves a context that was %s', async change => {
  const context = (await prepareManagedBacklogContext(root, item))!;
  const target = join(root, context.path);
  const contents = change === 'edited' ? 'owned by agent' : await readFile(target, 'utf8');
  if (change === 'replaced') await rename(target, `${target}.original`);
  await writeFile(target, contents);
  await expect(context.release()).rejects.toThrow('Refusing to remove changed backlog context');
  expect(await readFile(target, 'utf8')).toBe(contents);
});

it('refuses a symlinked artifact directory', async () => {
  await symlink(root, join(root, '.afk'), 'dir');
  await expect(prepareManagedBacklogContext(root, item)).rejects.toThrow('must not be a symbolic link');
});
