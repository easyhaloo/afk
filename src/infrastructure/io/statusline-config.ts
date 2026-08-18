import { promises as fs } from 'fs';
import { join } from 'path';
import { STATUS_FILENAME } from './status';

type JsonObject = Record<string, string | number | boolean | null | object>;

const SETTINGS_DIR = '.claude';
const SETTINGS_FILE = 'settings.local.json';

export async function configureStatusline(worktreeDir: string): Promise<void> {
  const claudeDir = join(worktreeDir, SETTINGS_DIR);
  const settingsPath = join(claudeDir, SETTINGS_FILE);
  const statusJsonPath = join(worktreeDir, '.afk', STATUS_FILENAME);

  await fs.mkdir(join(worktreeDir, '.afk'), { recursive: true });
  await fs.mkdir(claudeDir, { recursive: true });

  let existing: JsonObject = {};
  try {
    const content = await fs.readFile(settingsPath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === 'object') existing = parsed as JsonObject;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const existingStatusLine = existing.statusLine;
  const existingCommand = existingStatusLine && typeof existingStatusLine === 'object'
    ? String((existingStatusLine as { command?: unknown }).command ?? '')
    : '';
  const teeCommand = `tee '${statusJsonPath}' > /dev/null`;
  const newCommand = existingCommand.includes(statusJsonPath)
    ? existingCommand
    : existingCommand ? `(${teeCommand}) && ${existingCommand}` : teeCommand;

  const next: JsonObject = {
    ...existing,
    statusLine: {
      ...(existingStatusLine && typeof existingStatusLine === 'object' ? existingStatusLine : {}),
      type: 'command',
      command: newCommand,
    },
  };

  await fs.writeFile(settingsPath, JSON.stringify(next, null, 2) + '\n', 'utf-8');

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
