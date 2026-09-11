// ============================================================
// Auth Utility
// ============================================================
// Authentication helpers for API testing.
// Supports token-based and API key authentication.
// ============================================================

import { APIRequestContext } from '@playwright/test';

export interface AuthResult {
  token: string;
  userId: string;
}

/**
 * Login and extract token for subsequent requests
 *
 * @param apiContext - Playwright APIRequestContext
 * @param email - User email
 * @param password - User password
 * @returns Token and userId
 */
export async function login(
  apiContext: APIRequestContext,
  email: string,
  password: string
): Promise<AuthResult> {
  const res = await apiContext.post('/auth/login', {
    data: { email, password },
  });

  if (!res.ok()) {
    throw new Error(`Login failed: ${res.status()}`);
  }

  const body = await res.json();
  return {
    token: body.token,
    userId: body.userId,
  };
}

/**
 * Refresh an expired token
 *
 * @param apiContext - Playwright APIRequestContext
 * @param refreshToken - Refresh token from login
 * @returns New access token
 */
export async function refreshToken(
  apiContext: APIRequestContext,
  refreshToken: string
): Promise<string> {
  const res = await apiContext.post('/auth/refresh', {
    data: { refreshToken },
  });

  if (!res.ok()) {
    throw new Error(`Token refresh failed: ${res.status()}`);
  }

  const { accessToken } = await res.json();
  return accessToken;
}

/**
 * Create a new API context with Bearer token
 *
 * @param baseURL - Base URL for API
 * @param token - Bearer token
 * @returns New APIRequestContext with auth headers
 */
export async function createAuthContext(
  baseURL: string,
  token: string
): Promise<APIRequestContext> {
  const { request } = await import('@playwright/test');
  const context = await request.newContext({
    baseURL,
    extraHTTPHeaders: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });
  return context;
}

/**
 * Create a new API context with API key
 *
 * @param baseURL - Base URL for API
 * @param apiKey - API key
 * @returns New APIRequestContext with API key header
 */
export async function createApiKeyContext(
  baseURL: string,
  apiKey: string
): Promise<APIRequestContext> {
  const { request } = await import('@playwright/test');
  const context = await request.newContext({
    baseURL,
    extraHTTPHeaders: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
  });
  return context;
}
