import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const CLAUDE_PROJECT_PREFIX_LENGTH = 200;

export function claudeProjectSlug(workspace: string): string {
  return workspace.replace(/[/.]/g, '-');
}

export function claudeTranscriptPath(
  workspace: string,
  sessionId: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!/^[\w-]+$/.test(sessionId)) return undefined;
  let cwd = resolve(workspace);
  try { cwd = realpathSync(cwd); } catch { /* Worktree may already be gone. */ }
  const config = environment.CLAUDE_CONFIG_DIR
    ? resolve(cwd, environment.CLAUDE_CONFIG_DIR)
    : join(environment.HOME || homedir(), '.claude');
  const projects = join(config, 'projects');
  const slug = claudeProjectSlug(cwd);
  const filename = `${sessionId}.jsonl`;
  if (slug.length <= CLAUDE_PROJECT_PREFIX_LENGTH) return join(projects, slug, filename);

  const prefix = `${slug.slice(0, CLAUDE_PROJECT_PREFIX_LENGTH)}-`;
  let match: string | undefined;
  try {
    for (const project of readdirSync(projects, { withFileTypes: true })) {
      if (!project.isDirectory() || (project.name !== slug && !project.name.startsWith(prefix))) continue;
      const candidate = join(projects, project.name, filename);
      if (!matchesClaudeTranscript(candidate, cwd, sessionId)) continue;
      if (match) return undefined;
      match = candidate;
    }
  } catch {
    return undefined;
  }
  return match;
}

function matchesClaudeTranscript(path: string, cwd: string, sessionId: string): boolean {
  try {
    if (!lstatSync(path).isFile()) return false;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      let record: { cwd?: unknown; sessionId?: unknown; session_id?: unknown } | null;
      try { record = JSON.parse(line); } catch { continue; }
      const nativeId = record?.session_id ?? record?.sessionId;
      if (typeof nativeId !== 'string' || typeof record?.cwd !== 'string') continue;
      return nativeId === sessionId && record.cwd === cwd;
    }
  } catch {
    return false;
  }
  return false;
}
