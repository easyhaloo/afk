import { mkdir, mkdtemp, realpath, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeTurnWatcher, findClaudeTranscriptForDirectory } from './turn-watcher.js';
import { claudeProjectSlug } from '../../shared/agent-transcript-path.js';

/** One transcript entry, as Claude Code writes it. */
function entry(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

/** A turn that ran and handed the turn back to the user. */
const FINISHED_TURN = [
  entry({ type: 'user', message: { role: 'user', content: 'Implement the work item.' } }),
  entry({ type: 'api-request', id: 'req-1' }),
  entry({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Please run /login · API Error: 403 No active subscription' }] },
  }),
  entry({ type: 'system', subtype: 'turn_duration', durationMs: 3278 }),
];

/** A home with a transcript of the given worktree in it. */
async function fakeHome(lines: string[]): Promise<{ home: string; worktree: string }> {
  const home = await mkdtemp(join(tmpdir(), 'afk-claude-home-'));
  const worktree = await mkdtemp(join(tmpdir(), 'afk-claude-worktree-'));
  const slug = claudeProjectSlug(await realpath(worktree));
  const directory = join(home, '.claude', 'projects', slug);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'session.jsonl'), lines.join('\n'));
  return { home, worktree };
}

describe('findClaudeTranscriptForDirectory', () => {
  it('picks the newest transcript of the directory', async () => {
    const { home, worktree } = await fakeHome(FINISHED_TURN);
    const directory = join(home, '.claude', 'projects', claudeProjectSlug(await realpath(worktree)));
    await writeFile(join(directory, 'older.jsonl'), FINISHED_TURN.join('\n'));
    const past = new Date(Date.now() - 60_000);
    await utimes(join(directory, 'older.jsonl'), past, past);

    const found = await findClaudeTranscriptForDirectory(worktree, { rootDir: home });

    expect(found).toContain('session.jsonl');
  });

  it('skips a transcript written before the attempt started', async () => {
    const { home, worktree } = await fakeHome(FINISHED_TURN);

    const found = await findClaudeTranscriptForDirectory(worktree, { rootDir: home, sinceMs: Date.now() + 60_000 });

    expect(found).toBeUndefined();
  });

  it('returns no transcript when the directory was never visited', async () => {
    const home = await mkdtemp(join(tmpdir(), 'afk-claude-home-'));
    const worktree = await mkdtemp(join(tmpdir(), 'afk-claude-worktree-'));

    await expect(findClaudeTranscriptForDirectory(worktree, { rootDir: home })).resolves.toBeUndefined();
  });
});

describe('ClaudeTurnWatcher', () => {
  it('reports a turn that ended, with the agent\'s own words as the reason', async () => {
    const { home, worktree } = await fakeHome(FINISHED_TURN);
    const watcher = new ClaudeTurnWatcher();

    const verdict = await watcher.check(worktree, Date.now() - 60_000, home);

    expect(verdict?.ended).toBe(true);
    expect(verdict?.message).toContain('finished its turn without writing the completion signal');
    expect(verdict?.message).toContain('Please run /login');
  });

  it('reports nothing while the turn is still running', async () => {
    const { home, worktree } = await fakeHome([
      entry({ type: 'user', message: { role: 'user', content: 'Implement the work item.' } }),
      entry({ type: 'api-request', id: 'req-1' }),
    ]);
    const watcher = new ClaudeTurnWatcher();

    await expect(watcher.check(worktree, Date.now() - 60_000, home)).resolves.toBeUndefined();
  });

  it('reports nothing when another turn started after the last one ended', async () => {
    const { home, worktree } = await fakeHome([
      ...FINISHED_TURN,
      entry({ type: 'user', message: { role: 'user', content: 'now write the signal' } }),
      entry({ type: 'api-request', id: 'req-2' }),
    ]);
    const watcher = new ClaudeTurnWatcher();

    await expect(watcher.check(worktree, Date.now() - 60_000, home)).resolves.toBeUndefined();
  });

  it('ignores a line the tail cut in half', async () => {
    const { home, worktree } = await fakeHome(['{"type":"assist', ...FINISHED_TURN]);
    const watcher = new ClaudeTurnWatcher();

    const verdict = await watcher.check(worktree, Date.now() - 60_000, home);

    expect(verdict?.ended).toBe(true);
  });
});
