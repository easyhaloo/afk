import { expect, it, vi } from 'vitest';
import { configureGoogleAccountPlugins } from './google-account-plugins.js';

it('configures Gmail once and preserves existing recipient, credentials and disabled preferences', async () => {
  const configure = vi.fn();
  await configureGoogleAccountPlugins({ configure }, () => ({ plugins: [] }));
  expect(configure.mock.calls).toEqual([['credential.google-oauth', {}, true], ['notification.gmail', {}, true]]);
  configure.mockClear();
  await configureGoogleAccountPlugins({ configure }, () => ({ plugins: [{ id: 'notification.gmail', enabled: false, config: { to: 'me@example.test' } }] }));
  expect(configure.mock.calls).toEqual([['credential.google-oauth', {}, true]]);
});
