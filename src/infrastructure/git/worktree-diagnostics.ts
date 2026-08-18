import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { simpleGit } from 'simple-git';

const PROJECT_SETTINGS = '.claude/settings.json';
const LOCAL_SETTINGS = '.claude/settings.local.json';

export interface WorktreeDiagnostics {
  status: string[];
  changes: string[];
  settings: {
    tracked: boolean;
    changed: boolean;
    contentHash?: string;
    localSettingsExists: boolean;
    localSettingsHash?: string;
  };
}

/**
 * Captures the small subset of worktree state relevant to Claude configuration
 * without changing the repository. QA logs this at lifecycle boundaries so a
 * tracked settings mutation can be attributed to the preceding operation.
 */
export async function captureWorktreeDiagnostics(worktreePath: string): Promise<WorktreeDiagnostics> {
  const git = simpleGit(worktreePath);
  const [statusOutput, changesOutput, trackedOutput, settings, localSettings] = await Promise.all([
    git.raw(['status', '--short']),
    git.raw(['diff', '--name-status']),
    git.raw(['ls-files', '--error-unmatch', PROJECT_SETTINGS]).catch(() => ''),
    readOptionalFile(join(worktreePath, PROJECT_SETTINGS)),
    readOptionalFile(join(worktreePath, LOCAL_SETTINGS)),
  ]);

  const status = splitLines(statusOutput);
  return {
    status,
    changes: splitLines(changesOutput),
    settings: {
      tracked: trackedOutput.trim() === PROJECT_SETTINGS,
      changed: status.some(entry => entry.endsWith(PROJECT_SETTINGS)),
      contentHash: settings ? hash(settings) : undefined,
      localSettingsExists: localSettings !== undefined,
      localSettingsHash: localSettings ? hash(localSettings) : undefined,
    },
  };
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/).filter(Boolean);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
