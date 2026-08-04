# Browser Auth Runbook

How to set up and maintain authenticated browser state for each mode.

## storage-state

### Setup (one-time)

```bash
# Run the setup project to generate the auth state file
AUTH_STATE_FILE=playwright/.auth/user.json \
TEST_EMAIL=your-test-email@example.com \
TEST_PASSWORD=your-test-password \
  npx playwright test --project=setup
```

### Re-authentication

Delete the state file and re-run setup:

```bash
rm playwright/.auth/user.json
npx playwright test --project=setup
```

## persistent-profile

### Setup (one-time)

1. Create a dedicated profile directory:

   ```bash
   mkdir -p playwright/.profiles/main
   ```

2. Launch a temporary headed browser with the profile:

   ```bash
   AUTH_PROFILE_DIR=$(pwd)/playwright/.profiles/main \
     npx playwright test --headed --project=chromium
   ```

3. In the browser window, complete the manual login flow (SSO, MFA,
   passkey, etc.).

4. Close the browser. The profile directory now holds the authenticated
   session.

5. Subsequent test runs reuse the profile without re-authentication.

### Re-authentication

Delete the profile directory and repeat the one-time setup.

## localhost-cdp

### Setup (one-time)

1. Start Chromium with a dedicated profile and remote debugging:

   ```bash
   # macOS
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
     --user-data-dir=/path/to/playwright/.profiles/cdp \
     --remote-debugging-port=9222 \
     --remote-debugging-address=127.0.0.1

   # Or use Playwright's bundled Chromium:
   npx playwright install chromium
   ```

2. Log in manually in the launched browser window.

3. Set the endpoint environment variable:

   ```bash
   export CDP_ENDPOINT=http://127.0.0.1:9222
   ```

4. Run tests. The browser must remain running.

### Re-authentication

Re-authenticate in the external browser. The CDP connection will
pick up the new session state on the next test run.