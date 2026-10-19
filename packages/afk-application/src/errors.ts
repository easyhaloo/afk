/**
 * The structured error vocabulary shared by every AFK entry point.
 *
 * The CLI renders it into the `--json` failure envelope, and the desktop
 * client renders it into the recovery UI it shows for a failed backlog
 * operation. Both classify the same thrown error, so the classification has
 * to live with the use cases rather than in either presentation layer.
 */
export type ErrorCode =
  | 'auth'
  | 'not_found'
  | 'validation'
  | 'provider'
  | 'unknown';

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
