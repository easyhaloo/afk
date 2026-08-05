// ============================================================
// CDP Endpoint Validator
// ============================================================
// Validates a Chrome DevTools Protocol endpoint URL for safety.
// Only allows loopback hosts with explicit ports.
// Never logs the full endpoint; error messages are redacted.
// ============================================================

const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface ValidatedEndpoint {
  /** The normalized endpoint URL string. */
  url: string;
  /** Parsed hostname. */
  hostname: string;
  /** Parsed port number. */
  port: string;
}

/**
 * Parse and validate a CDP endpoint.
 *
 * Allowed:
 *   http://127.0.0.1:9222
 *   http://localhost:9222
 *   ws://127.0.0.1:9222/devtools/browser/<id>
 *   ws://[::1]:9222/devtools/browser/<id>
 *
 * Rejected:
 *   - Non-loopback hosts (0.0.0.0, LAN, public, remote)
 *   - URL credentials (user:pass@host)
 *   - Missing or empty port
 *   - Protocols other than http/ws
 *   - Query strings or fragments (may embed tokens)
 *
 * @param raw - Raw endpoint string from CDP_ENDPOINT env var.
 * @returns Validated endpoint.
 * @throws {Error} with a redacted message if validation fails.
 */
export function validateCdpEndpoint(raw: string): ValidatedEndpoint {
  if (!raw || raw.trim().length === 0) {
    throw new Error('CDP_ENDPOINT is required but not set.');
  }

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(
      'CDP_ENDPOINT is not a valid URL. ' +
      'Expected http://127.0.0.1:<port> or ws://127.0.0.1:<port>/devtools/browser/...'
    );
  }

  // Protocol must be http or ws
  if (url.protocol !== 'http:' && url.protocol !== 'ws:') {
    throw new Error(
      `CDP_ENDPOINT protocol must be 'http' or 'ws', got '${url.protocol.replace(':', '')}'.`
    );
  }

  // Reject credentials in URL
  if (url.username || url.password) {
    throw new Error(
      'CDP_ENDPOINT must not contain credentials (user:password@host).'
    );
  }

  // Reject query strings and fragments (may embed tokens)
  if (url.search || url.hash) {
    throw new Error(
      'CDP_ENDPOINT must not contain query parameters or fragments.'
    );
  }

  // Host must be exact loopback
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error(
      `CDP_ENDPOINT host must be localhost, 127.0.0.1, or [::1]. ` +
      `Got a hostname that is not in the allowed loopback set.`
    );
  }

  // Port is required
  if (!url.port) {
    throw new Error(
      'CDP_ENDPOINT must include an explicit port (e.g., http://127.0.0.1:9222).'
    );
  }

  return {
    url: url.href,
    hostname: url.hostname,
    port: url.port,
  };
}