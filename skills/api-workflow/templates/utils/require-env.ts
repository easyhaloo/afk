// ============================================================
// Required Environment Access
// ============================================================
// Fail-fast helper for required environment variables.
// Never logs or echoes secret values.
// ============================================================

/**
 * Require a named environment variable.
 * Throws if the variable is missing or empty.
 * The error message does NOT include the value.
 *
 * @example
 *   const apiKey = requireEnv('WIKI_API_KEY');
 *   const baseUrl = requireEnv('BASE_URL');
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Required environment variable '${name}' is not set.`
    );
  }
  return value;
}

/**
 * Require a named environment variable with a non-secret fallback
 * (e.g., a default localhost URL or a development identifier that is
 * safe to embed in source).
 *
 * Throws if the variable is missing/empty AND no fallback is provided.
 *
 * @example
 *   const baseUrl = requireEnvOrDefault('BASE_URL', 'http://localhost:8080');
 *   const kbId = requireEnvOrDefault('KB_ID', 'demo-kb');
 */
export function requireEnvOrDefault(
  name: string,
  fallback: string,
): string {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  return value;
}