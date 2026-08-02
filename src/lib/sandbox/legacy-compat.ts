/**
 * Legacy compatibility adapter — maps the legacy `.afk-signal.json` file to
 * an ExecutionResult. This is the fallback path for worktrees started before
 * Phase 8 that still rely on the agent writing the signal file.
 *
 * Phase 8 retirement plan:
 *   1. New agents no longer receive "write .afk-signal.json" instructions
 *      (see builtin.ts prompts + workflows.ts hardcoded phases).
 *   2. LocalAgentExecution.waitForResult still consults the signal file as
 *      a fallback so in-flight pre-Phase-8 worktrees keep working.
 *   3. When ALL pre-Phase-8 worktrees have completed (one release cycle),
 *      this adapter can be removed and `readSignal` can be deleted.
 *
 * The adapter is intentionally minimal: it only translates signal.type to
 * ExecutionResult.status, leaving structuredOutput = raw signal payload so
 * downstream code (issue comments, handoff docs) keeps working unchanged.
 */

import { readSignal } from '../core/io/signal';
import type { ExecutionResult } from './types';

/**
 * Read the legacy signal file and produce an ExecutionResult. Returns null
 * when the file is absent, corrupt, or its type is unrecognized.
 */
export async function readLegacySignalResult(
  worktreePath: string,
  runId: string,
): Promise<ExecutionResult | null> {
  let signal: { type: string; summary?: string; timestamp?: string } | null = null;
  try {
    signal = await readSignal(worktreePath);
  } catch {
    return null; // ENOENT, parse error, schema mismatch — treat as "no signal"
  }
  if (!signal) return null;

  // Map signal.type to ExecutionResult.status. Only goal_complete and
  // ac_result count as 'completed'; everything else (handoff_ready, timeout,
  // unknown) is 'failed' from the runner's perspective.
  const status: ExecutionResult['status'] =
    signal.type === 'goal_complete' || signal.type === 'ac_result' ? 'completed' : 'failed';

  return {
    version: 1,
    runId,
    status,
    provider: 'local',
    structuredOutput: signal,
    commits: [],
  };
}

/**
 * Build a 'failed' ExecutionResult for the rare case where the signal file
 * is present but contains an unrecognized type. Keeps the runner from
 * hanging on unknown legacy states.
 */
export function unrecognizedSignalResult(
  runId: string,
  rawType: string,
): ExecutionResult {
  return {
    version: 1,
    runId,
    status: 'failed',
    provider: 'local',
    error: {
      code: 'unrecognized_signal_type',
      message: `legacy signal type '${rawType}' is not mapped to a known ExecutionResult.status`,
    },
    commits: [],
  };
}