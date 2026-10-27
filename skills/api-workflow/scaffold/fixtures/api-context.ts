// Generic API context helpers for generated Playwright workflows.
// Replace auth configuration only when the target application's contract
// requires it. Context creation and disposal are explicit; no globalThis
// Playwright internals or domain-specific endpoint assumptions are used.

import { test, request, type APIRequestContext } from '@playwright/test';
import { requireEnvOrDefault } from '../utils/require-env';

let apiContext: APIRequestContext | undefined;

export function getApiContext(): APIRequestContext {
  if (!apiContext) {
    throw new Error(
      'API context is not initialized. Call this from a test file after its beforeAll hook.',
    );
  }
  return apiContext;
}

export async function createApiContext(
  options: {
    baseURL?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<APIRequestContext> {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  const apiKey = process.env.API_KEY;
  if (apiKey) {
    const headerName = requireEnvOrDefault('API_KEY_HEADER', 'X-API-Key');
    headers[headerName] = apiKey;
  }

  return request.newContext({
    baseURL: options.baseURL ?? requireEnvOrDefault('BASE_URL', 'http://localhost:8080'),
    extraHTTPHeaders: headers,
  });
}

export function authHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extra,
  };
  const apiKey = process.env.API_KEY;
  if (apiKey) {
    headers[requireEnvOrDefault('API_KEY_HEADER', 'X-API-Key')] = apiKey;
  }
  return headers;
}

test.beforeAll(async () => {
  // API_KEY is optional: the target application may use cookies, bearer
  // tokens, or no authentication. Generate the appropriate auth flow from
  // codebase evidence rather than assuming one scheme.
  apiContext = await createApiContext();
});

test.afterAll(async () => {
  if (apiContext) {
    await apiContext.dispose();
    apiContext = undefined;
  }
});
