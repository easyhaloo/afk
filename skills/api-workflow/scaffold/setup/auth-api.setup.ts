// API authentication setup template.
// This file is intentionally non-executable until the generator replaces
// the placeholder with the target application's discovered login flow.

import { test as setup } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const authFile = path.resolve(
  process.env.AUTH_STATE_FILE ?? 'playwright/.auth/user.json',
);

setup('authenticate via API', async ({ request }) => {
  void request; // Used by the generated login implementation.
  await mkdir(path.dirname(authFile), { recursive: true });

  // Replace this block with the real login request discovered in the target
  // codebase. Verify the response and ensure the resulting auth state is
  // compatible with the application's browser authentication mechanism.
  //
  // Example for cookie-based auth:
  // const response = await request.post('/auth/login', {
  //   data: {
  //     email: process.env.TEST_EMAIL,
  //     password: process.env.TEST_PASSWORD,
  //   },
  // });
  // if (!response.ok()) {
  //   throw new Error(`Login failed with HTTP ${response.status()}`);
  // }
  //
  // For bearer tokens stored in localStorage/sessionStorage, do not assume
  // request.storageState() is enough. Create a browser context, perform or
  // bridge the discovered login flow, and save the resulting browser state.

  throw new Error(
    'Auth setup is a template placeholder. Replace it with the target application login flow before running AUTH_MODE=storage-state.',
  );

  // mkdir is retained as the required step after implementing login:
  // await mkdir(path.dirname(authFile), { recursive: true });
  // await request.storageState({ path: authFile });
});
