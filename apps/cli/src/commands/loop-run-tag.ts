import { DEFAULT_LOOP_RUN_TAG, sanitizeLoopRunTag } from '@afk/runtime/infrastructure/process/pid-file';

/** What a `status`/`stop` command should act on, or the runs that make it ambiguous. */
export type CommandRunTagChoice = { readonly tag: string } | { readonly ambiguous: readonly string[] };

/**
 * The run a command acts on when the operator names none.
 *
 * `default` when that run is alive, otherwise the only live run. With several
 * live runs there is no single answer: guessing used to mean reporting "not
 * running" (and exiting 0) while loops were working, so the caller is told
 * which runs exist and can refuse instead.
 *
 * Pure, so the rule can be tested without a filesystem or a live loop.
 */
export function chooseCommandRunTag(explicit: string | undefined, live: readonly string[]): CommandRunTagChoice {
  if (explicit) return { tag: sanitizeLoopRunTag(explicit) };
  if (live.length === 0) return { tag: DEFAULT_LOOP_RUN_TAG };
  if (live.includes(DEFAULT_LOOP_RUN_TAG)) return { tag: DEFAULT_LOOP_RUN_TAG };
  if (live.length === 1) return { tag: live[0] };
  return { ambiguous: [...live] };
}
