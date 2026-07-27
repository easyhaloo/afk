import { promises as fs } from 'fs';
import { join } from 'path';
import { z } from 'zod';

/**
 * Reads Claude Code status data written by statusline command.
 *
 * Background: Claude Code pipes JSON via stdin to the configured statusline
 * command on every turn. We tee that JSON to a worktree-local file so both
 * the statusline renderer and AFK Runner can read authoritative token counts
 * — no fragile pane regex matching.
 *
 * Configure in ~/.claude/settings.json:
 *   {
 *     "statusLine": {
 *       "type": "command",
 *       "command": "tee <worktree>/.afk/claude-status.json > /dev/null && ccstatusline"
 *     }
 *   }
 */

/** Subset of Claude Code statusline payload we care about. */
export const ClaudeStatusSchema = z.object({
  model: z.object({
    display_name: z.string().optional(),
  }).optional(),
  context_window: z.object({
    context_window_size: z.number().int().positive().optional(),
    current_usage: z.object({
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
      cache_creation_input_tokens: z.number().int().nonnegative().optional(),
      cache_read_input_tokens: z.number().int().nonnegative().optional(),
    }).optional(),
  }).optional(),
  session_id: z.string().optional(),
});

export type ClaudeStatus = z.infer<typeof ClaudeStatusSchema>;

export interface TokenUsage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  total: number;
  contextWindow: number;
  /** Ratio of total/contextWindow in [0, 1]. 0 if context window unknown. */
  ratio: number;
}

export const STATUS_FILENAME = 'claude-status.json';

/**
 * Read the latest Claude status payload from <worktree>/.afk/claude-status.json.
 * Returns null if the file is missing or malformed.
 */
export async function readClaudeStatus(worktreeDir: string): Promise<ClaudeStatus | null> {
  const path = join(worktreeDir, '.afk', STATUS_FILENAME);
  try {
    const content = await fs.readFile(path, 'utf-8');
    const parsed = JSON.parse(content);
    return ClaudeStatusSchema.parse(parsed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // Malformed JSON or schema mismatch: treat as no data rather than crashing.
    return null;
  }
}

/**
 * Extract aggregate token usage from a status payload.
 * Returns zeros if no usage data is present.
 */
export function extractTokenUsage(status: ClaudeStatus | null): TokenUsage {
  const empty: TokenUsage = {
    input: 0,
    output: 0,
    cacheCreation: 0,
    cacheRead: 0,
    total: 0,
    contextWindow: 0,
    ratio: 0,
  };
  if (!status?.context_window?.current_usage) return empty;

  const u = status.context_window.current_usage;
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const cacheCreation = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const total = input + output + cacheCreation + cacheRead;
  const contextWindow = status.context_window.context_window_size ?? 0;
  const ratio = contextWindow > 0 ? total / contextWindow : 0;

  return { input, output, cacheCreation, cacheRead, total, contextWindow, ratio };
}

/**
 * Convenience: read status file and return aggregate token usage.
 * Returns zeros when file is missing.
 */
export async function getTokenUsage(worktreeDir: string): Promise<TokenUsage> {
  return extractTokenUsage(await readClaudeStatus(worktreeDir));
}