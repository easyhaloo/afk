/**
 * The backlog context file.
 *
 * A goal condition has a character budget and a backlog description does
 * not: the description carries the acceptance criteria — exactly what the
 * agent needs — and it grows with every criterion the work item gains.
 * Inlining it into the goal made the prompt grow with the work item until
 * the provider refused it, silently, half an hour before AFK could report
 * anything about it.
 *
 * Writing the description into the worktree decouples the two: the prompt
 * carries a pointer, the agent reads the file. The prompt stops growing with
 * the work item, and the agent still sees the whole requirement.
 *
 * The file lives under `.afk/`, the directory AFK already uses for its own
 * runtime artifacts. A managed repository must release the agent's copy
 * before publication checks the entire checkout for unexpected files.
 */

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { PromptSegment } from './execution-protocol.js';

/** The context file, relative to the worktree root. */
export const BACKLOG_CONTEXT_PATH = '.afk/backlog-context.md';

/**
 * The pointer the prompt carries in place of the description.
 *
 * It names the file and says what the file is for. The agent already works
 * in the worktree, so reading a file is something it can do.
 */
export function backlogContextPointer(path: string = BACKLOG_CONTEXT_PATH): string {
  return `Backlog context: the acceptance criteria and the full requirement text are written to ${path} in this worktree. Read that file before you start — it, not this prompt, is the source of truth for what to build or to verify.`;
}

/**
 * The context document.
 *
 * The description is kept verbatim: it is the acceptance criteria list, and
 * a summary of it would be a different requirement.
 */
export function buildBacklogContextDocument(input: { id: string; title: string; description: string }): string {
  return [
    `# Backlog context — ${input.title}`,
    '',
    `- Backlog id: ${input.id}`,
    `- Title: ${input.title}`,
    '',
    '## Description',
    '',
    input.description,
    '',
  ].join('\n');
}

/**
 * Write the context document into a worktree.
 *
 * Returns the absolute path that was written, so the caller can name it in
 * the failure evidence and in the prompt.
 */
export async function writeBacklogContext(
  worktreePath: string,
  input: { id: string; title: string; description: string },
): Promise<string> {
  const target = join(worktreePath, BACKLOG_CONTEXT_PATH);
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.writeFile(target, buildBacklogContextDocument(input), 'utf-8');
  return target;
}

export async function prepareManagedBacklogContext(worktreePath: string, item?: { id: string; title: string; description?: string }) {
  const description = item?.description?.trim();
  if (!item || !description) return undefined;
  const root = await fs.realpath(worktreePath);
  const directory = join(root, '.afk');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (await fs.realpath(directory) !== directory) throw new Error('Backlog context directory must not be a symbolic link');
  const path = `.afk/backlog-context-${randomUUID()}.md`;
  const target = join(root, path);
  const content = buildBacklogContextDocument({ ...item, description });
  const file = await fs.open(target, 'wx', 0o600);
  const original = await file.stat();
  try {
    await file.writeFile(content);
  } catch (error) {
    await fs.unlink(target);
    throw error;
  } finally {
    await file.close();
  }
  let released = false;
  const release = async () => {
    if (released) return;
    if (await fs.realpath(directory) !== directory) throw new Error('Backlog context directory changed');
    const current = await fs.lstat(target);
    if (!current.isFile() || current.dev !== original.dev || current.ino !== original.ino ||
      current.size !== Buffer.byteLength(content) || await fs.readFile(target, 'utf8') !== content) {
      throw new Error(`Refusing to remove changed backlog context: ${path}`);
    }
    await fs.unlink(target);
    released = true;
  };
  return { path, release, [Symbol.asyncDispose]: release };
}

/**
 * The goal segments of a work item.
 *
 * The task statement stays in the goal — it is what the agent is asked to
 * do, and dropping it would leave the agent with a file to read and no
 * task. The title stays, because it is short and identifies the work.
 * Everything unbounded goes to the file.
 */
export function buildGoalSegments(input: {
  /** The template's own task statement, including its `/goal` command. */
  taskStatement: string;
  title: string;
  /** The context file the agent has to read, when one was written. */
  contextPath?: string;
}): PromptSegment[] {
  const segments: PromptSegment[] = [
    { label: 'goal task statement', text: input.taskStatement },
    { label: 'backlog title', text: `Backlog title: ${input.title}` },
  ];
  if (input.contextPath) {
    segments.push({ label: 'backlog context pointer', text: backlogContextPointer(input.contextPath) });
  }
  return segments;
}
