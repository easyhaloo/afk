// ============================================================
// Auth Setup — API
// ============================================================
// Setup project that authenticates via API and writes the
// resulting auth state to a file. The generated code fills in
// the discovered login endpoint and credentials.
// ============================================================

import { test as setup } from '@playwright/test';
import path from 'path';
import { requireEnv } from '../utils/require-env';

const authFile = path.join(
  __dirname,
  '..',
  'playwright',
  '.auth',
  'user.json',
);

setup('authenticate via API', async ({ request }) => {
  // TODO: Replace with the discovered login endpoint and payload.
  // Example:
  //   await request.post('/auth/login', {
  //     data: {
  //       email: requireEnv('TEST_EMAIL'),
  //       password: requireEnv('TEST_PASSWORD'),
  //     },
  //   });

  await request.storageState({ path: authFile });
});