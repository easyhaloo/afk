// ============================================================
// API Context Fixture
// ============================================================
// Reusable API context for API tests.
// Handles auth headers, base URL, and context lifecycle.
//
// IMPORTANT FIXTURE RULES:
// 1. File-level shared context causes flaky tests on retry
// 2. Use test.beforeAll for init, test.afterAll for cleanup
// 3. Add null check in getter to fail fast if context invalid
// ============================================================

import { test, APIRequestContext } from '@playwright/test';

let apiContext: APIRequestContext | null = null;
let currentKbId: string;
let currentApiKey: string;

/**
 * Get the shared API context.
 * Throws if context is not initialized.
 */
export function getApiContext(): APIRequestContext {
  if (!apiContext) {
    throw new Error(
      'API context not initialized. ' +
      'Ensure test.beforeAll has run before using getApiContext().'
    );
  }
  return apiContext;
}

export function getCurrentKbId(): string {
  return currentKbId;
}

export function getCurrentApiKey(): string {
  return currentApiKey;
}

/**
 * Initialize API context.
 * Called once before all tests in the file.
 */
test.beforeAll(async () => {
  currentKbId = process.env.KB_ID || 'demo-kb';
  currentApiKey = process.env.WIKI_API_KEY || 'dev-api-key-12345';

  apiContext = await getNewApiContext(currentApiKey);
});

/**
 * Create a new API context with proper configuration.
 * Use this when you need an isolated context for a specific test.
 */
export async function getNewApiContext(apiKey?: string): Promise<APIRequestContext> {
  const key = apiKey || currentApiKey || process.env.WIKI_API_KEY || 'dev-api-key-12345';

  return await globalThis.test?.request?.newContext?.({
    baseURL: process.env.BASE_URL || 'http://localhost:8080',
    extraHTTPHeaders: {
      'Content-Type': 'application/json',
      'X-API-Key': key,
    },
  }) || await globalThis.request?.newContext?.({
    baseURL: process.env.BASE_URL || 'http://localhost:8080',
    extraHTTPHeaders: {
      'Content-Type': 'application/json',
      'X-API-Key': key,
    },
  });
}

/**
 * Clean up API context.
 * Called once after all tests in the file complete.
 */
test.afterAll(async () => {
  if (apiContext) {
    try {
      await apiContext.dispose();
      apiContext = null;
    } catch (e) {
      // Ignore: context may already be closed due to test retry
      console.log('[api-context] Context disposed or already closed');
    }
  }
});

/**
 * Build wiki-specific API endpoint path.
 * Use this instead of hardcoding paths.
 *
 * @example
 *   wikiEndpoint('/lint') → '/api/v1/knowledgebase/demo-kb/wiki/lint'
 *   wikiEndpoint('/review', 'other-kb') → '/api/v1/knowledgebase/other-kb/wiki/review'
 */
export function wikiEndpoint(path: string, kbId?: string): string {
  const kb = kbId || currentKbId;
  return `/api/v1/knowledgebase/${kb}/wiki${path}`;
}

/**
 * Create auth headers for API requests.
 * Ensures X-API-Key is always set correctly.
 */
export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const key = currentApiKey || process.env.WIKI_API_KEY || 'dev-api-key-12345';
  return {
    'Content-Type': 'application/json',
    'X-API-Key': key,
    ...extra,
  };
}
