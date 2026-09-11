import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getTokenUsage, STATUS_FILENAME } from './status';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('getTokenUsage', () => {
  it('aggregates a real Claude Code statusline payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-status-'));
    roots.push(root);
    await mkdir(join(root, '.afk'));
    await writeFile(join(root, '.afk', STATUS_FILENAME), JSON.stringify({
      session_id: 'session-1',
      model: { display_name: 'MiniMax-M2.7' },
      context_window: {
        context_window_size: 200_000,
        current_usage: {
          input_tokens: 5_610,
          output_tokens: 390,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 28_369,
        },
      },
    }));

    await expect(getTokenUsage(root)).resolves.toEqual({
      input: 5_610,
      output: 390,
      cacheCreation: 0,
      cacheRead: 28_369,
      total: 34_369,
      contextWindow: 200_000,
      ratio: 34_369 / 200_000,
    });
  });

  it('returns zero usage when the status file is missing or malformed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-status-'));
    roots.push(root);

    await expect(getTokenUsage(root)).resolves.toMatchObject({ total: 0, ratio: 0 });
    await mkdir(join(root, '.afk'));
    await writeFile(join(root, '.afk', STATUS_FILENAME), '{not-json');
    await expect(getTokenUsage(root)).resolves.toMatchObject({ total: 0, ratio: 0 });
  });
});
