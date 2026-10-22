import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The skills drive an agent that stages files. `.afk/` is ignored by Git,
 * so any instruction that stages it fails at run time, and any instruction
 * that commits it leaks absolute local paths into the repository. The
 * evidence contract is a written agreement — this test keeps it true.
 */

const SKILLS_DIR = join(process.cwd(), 'skills');

function skillMarkdownFiles(directory = SKILLS_DIR): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...skillMarkdownFiles(path));
      continue;
    }
    if (path.endsWith('.md')) found.push(path);
  }
  return found;
}

describe('skill evidence contract', () => {
  it('never asks the agent to stage or commit the ignored .afk directory', () => {
    const offenders = skillMarkdownFiles()
      .filter(path => /git\s+add[^\n]*\.afk/.test(readFileSync(path, 'utf-8')))
      .map(path => path.replace(`${SKILLS_DIR}/`, ''));
    expect(offenders).toEqual([]);
  });

  it('tells the agent that the QA stage, not the implementation stage, uploads the attachments', () => {
    for (const skill of ['afk-implement', 'afk-do']) {
      const reference = join(SKILLS_DIR, skill, 'references', 'hard-checks.md');
      const content = readFileSync(reference, 'utf-8');
      expect(content).toContain('The implementation stage uploads nothing.');
      expect(content).toContain('Do not commit the manifest');
    }
  });
});
