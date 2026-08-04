// ============================================================
// Browser Session Fixture — persistent-profile
// ============================================================
// Launches a dedicated Chromium browser with a persistent
// userDataDir. Suitable for one-time manual SSO/MFA/passkey login.
// The profile directory is preserved across test runs.
// ============================================================

import { test as base, expect, chromium } from '@playwright/test';
import type { BrowserContext, Page, Browser } from '@playwright/test';
import { requireEnv } from '../utils/require-env';

export { expect };

const AUTH_PROFILE_DIR = (() => {
  const dir = requireEnv('AUTH_PROFILE_DIR');
  // Reject known default personal profile paths
  const deny = [/[/\\]Google[/\\]Chrome[/\\]User Data$/i];
  for (const d of deny) {
    if (d.test(dir)) {
      throw new Error(
        'AUTH_PROFILE_DIR must not be the default personal Chrome ' +
        'profile directory. Create a dedicated automation profile instead.'
      );
    }
  }
  return dir;
})();

// CI guard
if (process.env.CI) {
  throw new Error(
    'persistent-profile mode is not supported in CI. ' +
    'Use storage-state mode for CI environments.'
  );
}

export const test = base.extend<{
  sessionContext: BrowserContext;
  sessionPage: Page;
}, {
  _ownedBrowser: Browser;
}>({
  // Worker-scoped: one browser instance per worker
  _ownedBrowser: [async ({}, use) => {
    const browser = await chromium.launchPersistentContext(
      AUTH_PROFILE_DIR,
      { headless: false },
    );
    // launchPersistentContext returns a BrowserContext, but the
    // returned object also exposes the browser via context.browser().
    // We track the context as the browser+context owner.
    const ctx = browser as unknown as BrowserContext;
    await use(ctx.browser()!);
    // Close the persistent context — this also closes the browser.
    // Do NOT delete the profile directory.
    await ctx.close();
  }, { scope: 'worker' }],

  // Worker-scoped persistent context
  sessionContext: [async ({ _ownedBrowser }, use) => {
    const contexts = _ownedBrowser.contexts();
    if (contexts.length === 0) {
      throw new Error(
        'Persistent context not found. The browser may have exited.'
      );
    }
    await use(contexts[0]);
  }, { scope: 'worker' }],

  // Test-scoped: each test gets a fresh page
  sessionPage: async ({ sessionContext }, use) => {
    const page = await sessionContext.newPage();
    try {
      await use(page);
    } finally {
      await page.close();
    }
  },
});