import { promises as fs } from 'fs';
import { join } from 'path';
import { STATUS_FILENAME } from './status';

const SETTINGS_DIR = '.claude';
const SETTINGS_FILE = 'settings.json';

/**
 * Configure the worktree's Claude Code statusline so it tees its stdin JSON
 * to <worktree>/.afk/claude-status.json in addition to (or instead of)
 * rendering a statusline. This is what lets AFK Runner read authoritative
 * token counts via getTokenUsage().
 *
 * Idempotent: re-running won't overwrite user customizations that aren't ours.
 */
export async function configureStatusline(worktreeDir: string): Promise<void> {
  const claudeDir = join(worktreeDir, SETTINGS_DIR);
  const settingsPath = join(claudeDir, SETTINGS_FILE);

  await fs.mkdir(join(worktreeDir, '.afk'), { recursive: true });
  await fs.mkdir(claudeDir, { recursive: true });

  let existing: Record<string, unknown> = {};
  try {
    const content = await fs.readFile(settingsPath, 'utf-8');
    existing = JSON.parse(content);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const statusJsonPath = join(worktreeDir, '.afk', STATUS_FILENAME);
  // Wrap any user-provided statusline command; if none, just tee JSON to file.
  const existingCommand =
    (existing.statusLine as { command?: string } | undefined)?.command ?? '';
  const teeCommand = `tee '${statusJsonPath}' > /dev/null`;
  const newCommand = existingCommand
    ? `(${teeCommand}) && ${existingCommand}`
    : teeCommand;

  const next = {
    ...existing,
    statusLine: {
      ...(existing.statusLine as Record<string, unknown> | undefined),
      type: 'command',
      command: newCommand,
    },
  };

  await fs.writeFile(settingsPath, JSON.stringify(next, null, 2) + '\n', 'utf-8');
}