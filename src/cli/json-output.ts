/**
 * Structured JSON output protocol for CLI commands consumed by external
 * callers (for example, the AFK Control desktop client).
 *
 * stdout envelope shapes:
 *   success: { ok: true,  kind: string, data: T }
 *   failure: { ok: false, kind: string, error: { code, message, details? } }
 *
 * When a command is invoked with `--json`, the action handler MUST emit
 * exactly one envelope on stdout, never human-formatted text. All human
 * output (chalk colors, hints, context) goes to stderr in non-JSON mode
 * only. Failure exits with code 1 so callers can detect transport-level
 * problems (no JSON on stdout) versus protocol-level failures.
 */

export type ErrorCode =
  | 'auth'
  | 'not_found'
  | 'validation'
  | 'provider'
  | 'unknown';

export type JsonSuccess<T> = {
  ok: true;
  kind: string;
  data: T;
};

export type JsonFailure = {
  ok: false;
  kind: string;
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
};

export type JsonEnvelope<T> = JsonSuccess<T> | JsonFailure;

export function emitSuccess<T>(kind: string, data: T): void {
  const envelope: JsonSuccess<T> = { ok: true, kind, data };
  process.stdout.write(JSON.stringify(envelope));
}

export function emitFailure(
  kind: string,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): never {
  const envelope: JsonFailure = {
    ok: false,
    kind,
    error: details ? { code, message, details } : { code, message },
  };
  process.stdout.write(JSON.stringify(envelope));
  process.exit(1);
}

/**
 * Map a thrown Error to a structured ErrorCode based on message heuristics.
 * Future work can introduce provider-specific detection (401 / 403 / 404)
 * to refine `provider` vs `auth` distinction; for now `auth` triggers on
 * token / login language and the rest falls back to `unknown`.
 */
export function classifyError(error: unknown): ErrorCode {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (
    message.includes('authentication')
    || message.includes('unauthorized')
    || message.includes('auth login')
    || message.includes('github_token')
    || message.includes('gitlab_token')
    || message.includes('not authenticated')
  ) {
    return 'auth';
  }
  if (
    message.includes('not found')
    || message.includes('does not exist')
    || message.includes('404')
  ) {
    return 'not_found';
  }
  if (
    message.includes('invalid')
    || message.includes('must ')
    || message.includes('expected ')
    || message.includes('argument')
  ) {
    return 'validation';
  }
  if (message.includes('api') || message.includes('http')) {
    return 'provider';
  }
  return 'unknown';
}
