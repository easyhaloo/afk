/**
 * Claude Code workspace-trust pre-acceptance.
 *
 * Claude Code shows a "Quick safety check" dialog the first time it opens a
 * directory it has never seen before. AFK always launches an agent inside a
 * freshly created git worktree, so that dialog always appears. The dialog
 * blocks the TUI, the statusline therefore never renders, and AFK's
 * readiness probe dies with `Timeout waiting for claude-code prompt` — the
 * run is then reported as `blocked/hitl` even though nothing is wrong with
 * the implementation.
 *
 * Claude Code persists the answer in `~/.claude.json`:
 *
 *   projects["<absolute path>"].hasTrustDialogAccepted = true
 *
 * and its own diagnostics point at exactly that key, so seeding the entry
 * before the process starts is the supported way to let the agent come up
 * unattended. The write is best-effort: a failure here must never abort a
 * run, it only means the operator may have to answer the dialog once.
 */
import { promises as fs, realpathSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const CONFIG_FILE_NAME = '.claude.json';
const PROJECTS_KEY = 'projects';
const TRUST_KEY = 'hasTrustDialogAccepted';
const DISABLE_ENV = 'AFK_CLAUDE_TRUST_PRESEED';
const MAX_ATTEMPTS = 3;

export interface ClaudeTrustOptions {
  /** Override the config file location (tests). */
  configFilePath?: string;
  /** Override the environment (tests). */
  env?: NodeJS.ProcessEnv;
}

export interface ClaudeTrustResult {
  /** True when every project key is trusted in the config file. */
  trusted: boolean;
  /** True when this call is the one that wrote the missing entries. */
  wrote: boolean;
  configFilePath: string;
  projectKeys: string[];
}

/** Absolute path of the Claude Code global state file. */
export function resolveClaudeConfigFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return configDir ? join(resolve(configDir), CONFIG_FILE_NAME) : join(homedir(), CONFIG_FILE_NAME);
}

/**
 * Every key Claude Code may use for the given directory.
 *
 * Claude Code derives the key from the process cwd. AFK passes the worktree
 * path straight through, but the path may contain a symlinked segment
 * (`/tmp` → `/private/tmp` on macOS). Seeding both spellings removes the
 * guesswork.
 */
export function claudeProjectKeys(worktreeDir: string): string[] {
  const keys = new Set<string>();
  const absolute = resolve(worktreeDir);
  keys.add(absolute);
  try {
    keys.add(realpathSync(absolute));
  } catch {
    /* the path may not exist yet — the plain form is enough */
  }
  return [...keys];
}

/** True when the argv launches Claude Code. */
export function isClaudeCodeArgv(argv: readonly string[]): boolean {
  const first = argv[0]?.trim();
  if (!first) return false;
  // Split on both separators — a Windows-style path may reach a POSIX host.
  const binary = first.split(/[/\\]/).pop() ?? '';
  return binary.replace(/\.(exe|cmd|bat)$/i, '') === 'claude';
}

/**
 * Mark the directory as trusted for Claude Code.
 *
 * Best-effort and idempotent: existing trust is preserved, unrelated
 * configuration is untouched, and a malformed config file is never
 * overwritten.
 */
export async function preacceptClaudeProjectTrust(
  worktreeDir: string,
  options: ClaudeTrustOptions = {},
): Promise<ClaudeTrustResult> {
  const env = options.env ?? process.env;
  const configFilePath = options.configFilePath ?? resolveClaudeConfigFilePath(env);
  const projectKeys = claudeProjectKeys(worktreeDir);
  const disabled = env[DISABLE_ENV]?.trim() === '0';
  if (disabled) {
    return { trusted: false, wrote: false, configFilePath, projectKeys };
  }

  let wrote = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const config = await readConfig(configFilePath);
    if (config === undefined) {
      // Unreadable or malformed — refuse to clobber the user's state file.
      return { trusted: false, wrote, configFilePath, projectKeys };
    }
    const projects = isJsonObject(config[PROJECTS_KEY]) ? config[PROJECTS_KEY] : {};
    const pending = projectKeys.filter(key => !isTrusted(projects, key));
    if (pending.length === 0) {
      return { trusted: true, wrote, configFilePath, projectKeys };
    }
    const nextProjects: JsonObject = { ...projects };
    for (const key of pending) {
      const existing = isJsonObject(nextProjects[key]) ? nextProjects[key] : {};
      nextProjects[key] = { ...existing, [TRUST_KEY]: true };
    }
    const written = await writeConfig(configFilePath, { ...config, [PROJECTS_KEY]: nextProjects });
    if (!written) {
      return { trusted: false, wrote, configFilePath, projectKeys };
    }
    wrote = true;
  }

  // A concurrent Claude Code process may have rewritten the file between our
  // write and the next read; report the observed state instead of claiming
  // success.
  const config = await readConfig(configFilePath);
  const projects = config && isJsonObject(config[PROJECTS_KEY]) ? config[PROJECTS_KEY] : {};
  const trusted = projectKeys.every(key => isTrusted(projects, key));
  return { trusted, wrote: wrote && trusted, configFilePath, projectKeys };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTrusted(projects: JsonObject, key: string): boolean {
  const entry = projects[key];
  return isJsonObject(entry) && entry[TRUST_KEY] === true;
}

async function readConfig(configFilePath: string): Promise<JsonObject | undefined> {
  let content: string;
  try {
    content = await fs.readFile(configFilePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeConfig(configFilePath: string, config: JsonObject): Promise<boolean> {
  const payload = JSON.stringify(config, null, 2) + '\n';
  const temporaryPath = `${configFilePath}.afk-${process.pid}.tmp`;
  try {
    await fs.writeFile(temporaryPath, payload, { encoding: 'utf-8', mode: 0o600 });
    await fs.rename(temporaryPath, configFilePath);
    return true;
  } catch {
    await fs.unlink(temporaryPath).catch(() => undefined);
    return false;
  }
}
