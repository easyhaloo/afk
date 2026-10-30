import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexTurnWatcher, findCodexRolloutForDirectory, readCodexTurnFailure } from './turn-failure.js';

const WORKDIR = '/tmp/afk-worktree-7';

async function fixtureRoot(): Promise<{ root: string; day: string }> {
  // The locator takes a home directory and looks in its `.codex/sessions`.
  const root = await mkdtemp(join(tmpdir(), 'afk-codex-home-'));
  const day = join(root, '.codex', 'sessions', '2026', '10', '30');
  await mkdir(day, { recursive: true });
  return { root, day };
}

async function writeRollout(day: string, name: string, cwd: string, lines: unknown[]): Promise<string> {
  const path = join(day, name);
  await writeFile(path, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  return path;
}

const sessionMeta = (cwd: string) => ({ type: 'session_meta', payload: { cwd } });
const taskComplete = (error?: { message: string; codex_error_info?: string }) => ({
  type: 'event_msg',
  payload: { type: 'task_complete', ...(error ? { error } : {}) },
});

describe('codex turn failure', () => {
  it('reads a turn that ended in an error', async () => {
    const { day } = await fixtureRoot();
    const path = await writeRollout(day, 'rollout-1.jsonl', WORKDIR, [
      sessionMeta(WORKDIR),
      { type: 'event_msg', payload: { type: 'token_count' } },
      taskComplete({ message: 'stream disconnected before completion: error sending request', codex_error_info: 'other' }),
    ]);

    await expect(readCodexTurnFailure(path)).resolves.toEqual({
      message: 'stream disconnected before completion: error sending request',
      code: 'other',
    });
  });

  it('reads a turn that completed as no failure', async () => {
    const { day } = await fixtureRoot();
    const path = await writeRollout(day, 'rollout-2.jsonl', WORKDIR, [
      sessionMeta(WORKDIR),
      taskComplete(),
    ]);

    await expect(readCodexTurnFailure(path)).resolves.toBeUndefined();
  });

  it('reads a turn that is still running as no failure', async () => {
    const { day } = await fixtureRoot();
    const path = await writeRollout(day, 'rollout-3.jsonl', WORKDIR, [
      sessionMeta(WORKDIR),
      { type: 'event_msg', payload: { type: 'token_count' } },
    ]);

    await expect(readCodexTurnFailure(path)).resolves.toBeUndefined();
  });

  it('finds the rollout of a working directory', async () => {
    const { root, day } = await fixtureRoot();
    await writeRollout(day, 'rollout-other.jsonl', '/somewhere/else', [sessionMeta('/somewhere/else')]);
    await writeRollout(day, 'rollout-mine.jsonl', WORKDIR, [sessionMeta(WORKDIR)]);

    await expect(findCodexRolloutForDirectory(WORKDIR, { rootDir: root })).resolves.toContain('rollout-mine.jsonl');
    await expect(findCodexRolloutForDirectory('/nowhere', { rootDir: root })).resolves.toBeUndefined();
  });

  it('leaves out a rollout from an earlier attempt in the same worktree', async () => {
    const { root, day } = await fixtureRoot();
    const earlier = await writeRollout(day, 'rollout-earlier.jsonl', WORKDIR, [
      sessionMeta(WORKDIR),
      taskComplete({ message: 'stream disconnected before completion' }),
    ]);
    await new Promise(resolve => setTimeout(resolve, 20));
    const later = await writeRollout(day, 'rollout-later.jsonl', WORKDIR, [sessionMeta(WORKDIR)]);

    // Nothing was written after this moment, so no rollout belongs to it.
    expect(await findCodexRolloutForDirectory(WORKDIR, { rootDir: root, sinceMs: Date.now() + 60_000 })).toBeUndefined();

    // The attempt that started between the two files sees only the second.
    const since = (await stat(earlier)).mtimeMs + 5;
    expect(await findCodexRolloutForDirectory(WORKDIR, { rootDir: root, sinceMs: since })).toBe(later);
  });

  describe('watching', () => {
    it('reports the failure once the rollout records one', async () => {
      const { root, day } = await fixtureRoot();
      const path = await writeRollout(day, 'rollout-watch.jsonl', WORKDIR, [sessionMeta(WORKDIR)]);
      const watcher = new CodexTurnWatcher();

      await expect(watcher.check(WORKDIR, undefined, root)).resolves.toBeUndefined();

      await writeFile(
        path,
        [
          JSON.stringify(sessionMeta(WORKDIR)),
          JSON.stringify(taskComplete({ message: 'stream disconnected before completion' })),
        ].join('\n') + '\n',
      );

      await expect(watcher.check(WORKDIR, undefined, root)).resolves.toMatchObject({
        message: 'stream disconnected before completion',
      });
    });

    it('keeps the verdict it already found', async () => {
      const { root, day } = await fixtureRoot();
      const path = await writeRollout(day, 'rollout-watch2.jsonl', WORKDIR, [
        sessionMeta(WORKDIR),
        taskComplete({ message: 'stream disconnected before completion' }),
      ]);
      const watcher = new CodexTurnWatcher();

      await expect(watcher.check(WORKDIR, undefined, root)).resolves.toMatchObject({ message: 'stream disconnected before completion' });
      // The rollout did not grow, so it is not read again — and the verdict stands.
      await expect(watcher.check(WORKDIR, undefined, root)).resolves.toMatchObject({ message: 'stream disconnected before completion' });
    });
  });
});
