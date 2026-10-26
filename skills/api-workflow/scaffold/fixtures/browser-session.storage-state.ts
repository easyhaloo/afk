// ============================================================
// Browser Session Fixture — storage-state
// ============================================================
// Loads a pre-generated auth state file into isolated Playwright
// browser contexts. Setup (API or UI) is handled by a separate
// setup project. The state file is produced once and reused.
// ============================================================

import { test as base, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

export { expect };

const AUTH_STATE_FILE =
  process.env.AUTH_STATE_FILE || 'playwright/.auth/user.json';

export const test = base.extend<{
  sessionContext: BrowserContext;
  sessionPage: Page;
}>({
  // sessionContext is the built-in isolated context. The config
  // already loads auth state from AUTH_STATE_FILE via use.storageState.
  sessionContext: async ({ context }, use) => {
    await use(context);
  },

  // sessionPage is the built-in isolated page.
  sessionPage: async ({ page }, use) => {
    await use(page);
  },
});

// ----- Manual sessionStorage restore (uncomment if needed) -----
//
// If your application stores auth tokens in sessionStorage, the
// built-in storageState mechanism does not persist them. Use the
// following pattern:
//
// 1. In the setup project, after authentication:
//    const ss = await page.evaluate(() =>
//      JSON.stringify(sessionStorage));
//    fs.writeFileSync('playwright/.auth/session.json', ss);
//
// 2. In this fixture, add:
//    import fs from 'fs';
//    import path from 'path';
//
//    const sessionFile = path.resolve(
//      process.env.AUTH_STATE_FILE?.replace(/\.json$/, '-session.json') ??
//      'playwright/.auth/user-session.json');
//
//    sessionContext: [async ({ context }, use) => {
//      if (fs.existsSync(sessionFile)) {
//        const ss = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
//        await context.addInitScript((storage) => {
//          for (const [k, v] of Object.entries(storage))
//            window.sessionStorage.setItem(k, v as string);
//        }, ss);
//      }
//      await use(context);
//    }, { scope: 'test' }],