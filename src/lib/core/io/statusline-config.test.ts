import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { STATUS_FILENAME } from './status';
import { configureStatusline } from './statusline-config';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function readSettings(root: string): Promise<{ statusLine: { command: string } }> {
  return JSON.parse(await readFile(join(root, '.claude', 'settings.json'), 'utf8')) as { statusLine: { command: string } };
}

describe('configureStatusline', () => {
  it('owns the statusline command without nesting wrappers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-statusline-'));
    roots.push(root);
    await configureStatusline(root);
    const settingsPath = join(root, '.claude', 'settings.json');
    await writeFile(settingsPath, JSON.stringify({
      permissions: { allow: ['Read(*)'] },
      statusLine: { type: 'command', command: 'custom-statusline' },
    }));

    await configureStatusline(root);
    await configureStatusline(root);

    const tee = `tee '${join(root, '.afk', STATUS_FILENAME)}' > /dev/null`;
    await expect(readSettings(root)).resolves.toMatchObject({
      permissions: { allow: ['Read(*)'] },
      statusLine: { command: tee },
    });
    const command = (await readSettings(root)).statusLine.command;
    expect(command).not.toContain('&&');
    expect(command).not.toContain('|');
  });

  it('replaces a legacy AFK tee chain with one direct command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-statusline-'));
    roots.push(root);
    const legacy = `(tee '${join(root, '.afk', STATUS_FILENAME)}' > /dev/null) && (tee '/tmp/old/.afk/${STATUS_FILENAME}' > /dev/null)`;
    await configureStatusline(root);
    await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify({ statusLine: { command: legacy } }));

    await configureStatusline(root);

    const tee = `tee '${join(root, '.afk', STATUS_FILENAME)}' > /dev/null`;
    await expect(readSettings(root)).resolves.toMatchObject({
      statusLine: { command: tee },
    });
  });
});
