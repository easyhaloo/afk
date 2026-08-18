import { APIRequestContext, request } from '@playwright/test';

/**
 * Create an API context using a repository-discovered Bearer token.
 */
export async function createBearerContext(
  baseURL: string | undefined,
  token: string,
): Promise<APIRequestContext> {
  return request.newContext({
    baseURL,
    extraHTTPHeaders: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });
}

/**
 * Create an API context using a repository-discovered API key.
 */
export async function createApiKeyContext(
  baseURL: string | undefined,
  apiKey: string,
  headerName = 'X-API-Key',
): Promise<APIRequestContext> {
  return request.newContext({
    baseURL,
    extraHTTPHeaders: {
      'Content-Type': 'application/json',
      [headerName]: apiKey,
    },
  });
}
