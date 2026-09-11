// ============================================================
// Auth Setup — UI
// ============================================================
// Setup project that authenticates via browser UI and writes the
// resulting auth state to a file. The generated code fills in the
// discovered login page URL, selectors, and credential env vars.
// ============================================================

import { test as setup, expect } from '@playwright/test';
import path from 'path';
import { requireEnv } from '../utils/require-env';

const authFile = path.join(
  __dirname,
  '..',
  'playwright',
  '.auth',
  'user.json',
);

setup('authenticate via UI', async ({ page }) => {
  // TODO: Replace with the discovered login page URL, selectors,
  // and credential env var names.
  //
  // Example:
  //   await page.goto(requireEnv('BASE_URL') + '/login');
  //   await page.getByLabel('Email').fill(requireEnv('TEST_EMAIL'));
  //   await page.getByLabel('Password').fill(requireEnv('TEST_PASSWORD'));
  //   await page.getByRole('button', { name: 'Sign in' }).click();
  //
  // Wait for the post-login URL or a stable authenticated element:
  //   await page.waitForURL('**/dashboard');
  //   await expect(page.getByText('Welcome')).toBeVisible();

  await page.context().storageState({ path: authFile });
});