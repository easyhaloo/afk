import { promises as fs } from 'fs';
import { join } from 'path';
import { STATUS_FILENAME } from './status';

const SETTINGS_DIR = '.claude';
const SETTINGS_FILE = 'settings.local.json';

/**
 * Configure the worktree's local Claude Code statusline so it tees its stdin JSON
 * to <worktree>/.afk/claude-status.json in addition to (or instead of)
 * rendering a statusline. This is what lets AFK Runner read authoritative
 * token counts via getTokenUsage().
 *
 * Also writes an empty placeholder status file up front so the Runner can
 * detect "session is up" via file presence immediately. The real statusline
 * tee overwrites this on the first turn.
 *
 * The tracked project settings remain untouched. Re-running only updates the
 * local override and never duplicates its tee command.
 */
export async function configureStatusline(worktreeDir: string): Promise<void> {
  const claudeDir = join(worktreeDir, SETTINGS_DIR);
  const settingsPath = join(claudeDir, SETTINGS_FILE);
  const statusJsonPath = join(worktreeDir, '.afk', STATUS_FILENAME);

  await fs.mkdir(join(worktreeDir, '.afk'), { recursive: true });
  await fs.mkdir(claudeDir, { recursive: true });

  let existing: Record<string, unknown> = {};
  try {
    const content = await fs.readFile(settingsPath, 'utf-8');
    existing = JSON.parse(content);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  // Wrap any user-provided statusline command; if none, just tee JSON to file.
  const existingCommand =
    (existing.statusLine as { command?: string } | undefined)?.command ?? '';
  const teeCommand = `tee '${statusJsonPath}' > /dev/null`;
  const newCommand = existingCommand.includes(statusJsonPath)
    ? existingCommand
    : existingCommand
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

  // Write placeholder status so waitForPrompt can detect "ready" before the
  // first statusline invocation (which happens on the first turn, not at startup).
  // Real statusline tee will overwrite this with full payload.
  try {
    await fs.access(statusJsonPath);
  } catch {
    await fs.writeFile(
      statusJsonPath,
      JSON.stringify({ placeholder: true, note: 'AFK pre-launch; statusline will overwrite' }, null, 2),
      'utf-8',
    );
  }
}
