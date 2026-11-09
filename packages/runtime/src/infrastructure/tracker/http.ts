import { IssueTrackerError, configurationError } from './issue-tracker-error.js';

export type FetchLike = typeof globalThis.fetch;

export interface JsonRequestOptions<T> {
  readonly provider: string;
  readonly operation: string;
  readonly url: URL;
  readonly fetch: FetchLike;
  readonly init: RequestInit;
  readonly timeoutMs?: number;
  readonly statuses?: readonly number[];
  readonly allowEmpty?: boolean;
  readonly schema?: { parse(value: unknown): T };
}

export function normalizeBaseUrl(provider: string, operation: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationError(provider, operation, 'base URL is invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw configurationError(provider, operation, 'base URL must use http(s) without credentials, query data or fragment');
  }
  return url.toString().replace(/\/$/, '');
}

export function listLimit(limit: number | undefined, provider: string): number {
  if (limit === undefined) return 50;
  if (!Number.isSafeInteger(limit) || limit < 1) throw configurationError(provider, 'listIssues', 'limit must be a positive safe integer');
  return limit;
}

export async function requestJson<T>(options: JsonRequestOptions<T>): Promise<T> {
  const details = { provider: options.provider, operation: options.operation };
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw configurationError(options.provider, options.operation, 'timeoutMs must be a positive timer duration');
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.init.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.init.signal?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        let response: Response;
        let text: string;
        try {
          response = await options.fetch(options.url, { ...options.init, signal: controller.signal, redirect: 'error' });
        } catch {
          throw new IssueTrackerError('request-failed', 'tracker request failed', details);
        }
        if (!response.ok) {
          const code = response.status === 401 ? 'authentication' : response.status === 403 ? 'forbidden'
            : response.status === 404 ? 'not-found' : response.status === 429 ? 'rate-limited' : 'request-failed';
          throw new IssueTrackerError(code, `tracker request returned HTTP ${response.status}`, {
            ...details, status: response.status, retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
          });
        }
        if (options.statuses && !options.statuses.includes(response.status)) {
          throw new IssueTrackerError('invalid-response', 'tracker returned an unexpected success status', { ...details, status: response.status });
        }
        try {
          text = await response.text();
        } catch {
          throw new IssueTrackerError('request-failed', 'tracker response read failed', details);
        }
        if (!text.trim() && options.allowEmpty) return undefined as T;
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          throw new IssueTrackerError('invalid-response', 'tracker returned invalid or empty JSON', details);
        }
        if (body && typeof body === 'object') {
          const object = body as { errors?: unknown; errorMessages?: unknown; error?: unknown; success?: unknown };
          const hasErrors = (value: unknown) => Array.isArray(value) ? value.length > 0
            : typeof value === 'object' && value !== null ? Object.keys(value).length > 0 : Boolean(value);
          if (hasErrors(object.errors) || hasErrors(object.errorMessages) || hasErrors(object.error) || object.success === false) {
            throw new IssueTrackerError('request-failed', 'tracker returned an error payload', details);
          }
        }
        try {
          if (options.schema) return options.schema.parse(body);
          if (!options.allowEmpty) throw new Error();
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new Error();
          return undefined as T;
        } catch {
          throw new IssueTrackerError('invalid-response', 'tracker response did not match the expected schema', details);
        }
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new IssueTrackerError('timeout', 'tracker request timed out', details));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    options.init.signal?.removeEventListener('abort', onAbort);
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}
