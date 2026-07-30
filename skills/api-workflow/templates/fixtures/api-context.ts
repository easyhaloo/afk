// ============================================================
// API Context Fixture
// ============================================================
// Reusable API context for all tests. Handles auth headers,
// base URL configuration, and cleanup.
// ============================================================

import { test, APIRequestContext } from '@playwright/test';

export interface ApiContextOptions {
  baseURL?: string;
  authHeader?: string;
  token?: string;
}

let apiContext: APIRequestContext;
let authToken: string;

export function getApiContext(): APIRequestContext {
  return apiContext;
}

export function getAuthToken(): string {
  return authToken;
}

test.beforeAll(async ({ playwright }) => {
  apiContext = await playwright.request.newContext({
    baseURL: process.env.BASE_URL || 'https://api.example.com',
    extraHTTPHeaders: {
      'Content-Type': 'application/json',
      ...(authToken && { Authorization: `Bearer ${authToken}` }),
    },
  });
});

test.afterAll(async () => {
  await apiContext.dispose();
});

// Set token for authenticated requests
export function setAuthToken(token: string): void {
  authToken = token;
}

// Create authenticated headers
export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(authToken && { Authorization: `Bearer ${authToken}` }),
    ...extra,
  };
}
