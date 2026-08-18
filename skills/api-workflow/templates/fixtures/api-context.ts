import { APIRequestContext, request } from '@playwright/test';

export interface ApiContextOptions {
  baseURL?: string;
  headers?: Record<string, string>;
}

/**
 * Create an isolated API context from repository-specific configuration.
 * Authentication and endpoint contracts must be supplied by the generated test.
 */
export async function createApiContext(
  options: ApiContextOptions = {},
): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: options.baseURL ?? process.env.BASE_URL,
    extraHTTPHeaders: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
}

/**
 * Build request headers without assuming an authentication scheme.
 */
export function mergeHeaders(
  headers: Record<string, string> = {},
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...headers,
    ...extra,
  };
}
