import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BACKLOG_CONTEXT_PATH,
  backlogContextPointer,
  buildBacklogContextDocument,
  buildGoalSegments,
  writeBacklogContext,
} from './backlog-context.js';

describe('backlog context document', () => {
  it('keeps the description verbatim', () => {
    const description = '- [ ] the entry hugs the bottom edge -- pnpm e2e\n- [ ] /s enters search';

    const document = buildBacklogContextDocument({ id: '42', title: 'Interactive JSON proof', description });

    expect(document).toContain('# Backlog context — Interactive JSON proof');
    expect(document).toContain('- Backlog id: 42');
    expect(document).toContain(description);
  });

  it('names the file and says what it is for', () => {
    const pointer = backlogContextPointer();

    expect(pointer).toContain(BACKLOG_CONTEXT_PATH);
    expect(pointer).toContain('acceptance criteria');
    expect(pointer).toContain('Read that file before you start');
  });
});

describe('goal segments', () => {
  it('keeps the task statement and the title, and points at the context file', () => {
    const segments = buildGoalSegments({
      taskStatement: '/goal verify the acceptance criteria',
      title: 'Interactive JSON proof',
      contextPath: BACKLOG_CONTEXT_PATH,
    });

    expect(segments.map(segment => segment.label)).toEqual([
      'goal task statement',
      'backlog title',
      'backlog context pointer',
    ]);
    expect(segments[0].text).toBe('/goal verify the acceptance criteria');
    expect(segments[1].text).toBe('Backlog title: Interactive JSON proof');
    expect(segments[2].text).toContain(BACKLOG_CONTEXT_PATH);
  });

  it('leaves the pointer out when there is no context file', () => {
    const segments = buildGoalSegments({ taskStatement: '/goal verify', title: 'Interactive JSON proof' });

    expect(segments.map(segment => segment.label)).toEqual(['goal task statement', 'backlog title']);
  });
});

describe('backlog context file', () => {
  it('writes the context into the worktree, under the runtime artifact directory', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'afk-backlog-context-'));

    const written = await writeBacklogContext(worktree, {
      id: '42',
      title: 'Interactive JSON proof',
      description: 'the entry hugs the bottom edge',
    });

    expect(written).toBe(join(worktree, BACKLOG_CONTEXT_PATH));
    const content = await readFile(written, 'utf-8');
    expect(content).toContain('the entry hugs the bottom edge');
    await rm(worktree, { recursive: true, force: true });
  });

  it('replaces an earlier context instead of appending to it', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'afk-backlog-context-'));

    await writeBacklogContext(worktree, { id: '42', title: 'first', description: 'first description' });
    await writeBacklogContext(worktree, { id: '42', title: 'second', description: 'second description' });

    const content = await readFile(join(worktree, BACKLOG_CONTEXT_PATH), 'utf-8');
    expect(content).toContain('second description');
    expect(content).not.toContain('first description');
    await rm(worktree, { recursive: true, force: true });
  });
});
