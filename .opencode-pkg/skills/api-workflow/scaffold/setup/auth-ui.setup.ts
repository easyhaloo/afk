// UI authentication setup template.
// The generator must replace the placeholder with the login page and
// selectors discovered in the target application before enabling this mode.

import { test as setup } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const authFile = path.resolve(
  process.env.AUTH_STATE_FILE ?? 'playwright/.auth/user.json',
);

setup('authenticate via UI', async ({ page }) => {
  void page; // Used by the generated login implementation.
  await mkdir(path.dirname(authFile), { recursive: true });

  // Replace with the real UI login flow discovered in the target repository.
  // Example:
  // await page.goto(new URL('/login', process.env.BASE_URL).toString());
  // await page.getByLabel('Email').fill(process.env.TEST_EMAIL!);
  // await page.getByLabel('Password').fill(process.env.TEST_PASSWORD!);
  // await page.getByRole('button', { name: 'Sign in' }).click();
  // await page.waitForURL('**/dashboard');
  //
  // Verify an authenticated page element before saving state. If the app
  // stores auth in sessionStorage, persist and restore it explicitly; the
  // built-in storageState file does not include sessionStorage.

  throw new Error(
    'UI auth setup is a template placeholder. Replace it with the target application login flow before running AUTH_MODE=storage-state.',
  );

  // Keep this after successful login and verification:
  // await page.context().storageState({ path: authFile });
});
