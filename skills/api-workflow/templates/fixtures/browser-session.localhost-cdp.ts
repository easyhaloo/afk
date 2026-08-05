// ============================================================
// Browser Session Fixture — localhost-cdp
// ============================================================
// Attaches to an already-running Chromium instance over a loopback
// CDP endpoint. The user must have started the browser with a
// dedicated --user-data-dir and --remote-debugging-port.
// ============================================================

import { test as base, expect, chromium } from '@playwright/test';
import type { BrowserContext, Page, Browser } from '@playwright/test';
import { requireEnv } from '../utils/require-env';
import { validateCdpEndpoint } from '../utils/cdp-endpoint';

export { expect };

// CI guard
if (process.env.CI) {
  throw new Error(
    'localhost-cdp mode is not supported in CI. ' +
    'Use storage-state mode for CI environments.'
  );
}

// Validate and redact the endpoint
const endpoint = (() => {
  const raw = requireEnv('CDP_ENDPOINT');
  return validateCdpEndpoint(raw);
})();

export const test = base.extend<{
  sessionContext: BrowserContext;
  sessionPage: Page;
}, {
  _cdpBrowser: Browser;
  _preExistingPages: Page[];
}>({
  // Worker-scoped: one CDP connection per worker
  _cdpBrowser: [async ({}, use) => {
    const browser = await chromium.connectOverCDP(endpoint.url, {
      noDefaults: true,
      timeout: 15_000,
    });
    try {
      await use(browser);
    } finally {
      // Close the Playwright connection. This does NOT close the
      // external browser or its pre-existing pages.
      await browser.close();
    }
  }, { scope: 'worker' }],

  // Snapshot pre-existing pages — never close them
  _preExistingPages: [async ({ _cdpBrowser }, use) => {
    const contexts = _cdpBrowser.contexts();
    if (contexts.length === 0) {
      throw new Error(
        'No browser contexts found on the CDP endpoint. ' +
        'Ensure the browser has at least one open tab.'
      );
    }
    const pages = contexts[0].pages();
    await use(pages);
  }, { scope: 'worker' }],

  // The existing default context — borrowed, not owned
  sessionContext: async ({ _cdpBrowser }, use) => {
    const context = _cdpBrowser.contexts()[0];
    await use(context);
  },

  // Test-scoped: each test gets a NEW page in the existing context.
  // Pre-existing pages are never touched.
  sessionPage: async ({ sessionContext }, use) => {
    const page = await sessionContext.newPage();
    try {
      await use(page);
    } finally {
      // Close ONLY the test-owned page.
      await page.close();
    }
  },
});