# Browser Auth Runbook

Select one mode based on the environment. Copy only the selected mode's fixture
and setup file into the generated project.

| Runs where | Mode | Setup |
|------------|------|-------|
| Local development with an already-authenticated dedicated Chromium | `localhost-cdp` | Start Chrome with loopback CDP and log in manually |
| CI/non-interactive environment | `storage-state` | Implement the generated setup flow, then run the setup project |

## localhost-cdp (local development)

Use a dedicated browser profile, never the default personal profile.

```bash
mkdir -p ~/.afk-browser-profile
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir="$HOME/.afk-browser-profile" \
  --remote-debugging-port=9222 \
  --no-first-run about:blank &
export CDP_ENDPOINT=http://127.0.0.1:9222
```

Log in through that Chrome window before running tests. The profile persists
session state across restarts. If the session expires, log in again.

Security:
- Treat the CDP endpoint and browser profile as credentials.
- Bind CDP to loopback only; never expose it on a network interface.
- Never commit the profile directory or endpoint value.
- The fixture rejects CI and non-loopback CDP endpoints.

## storage-state (CI)

The setup file is a template, not a universal login implementation. Before
running it, replace the placeholder with the login flow discovered in the
target repository. Verify the response and confirm that the resulting state
matches the application's auth mechanism. API request storage state captures
cookies, but does not automatically translate a bearer token into browser
localStorage or sessionStorage.

After implementing the setup file:

```bash
AUTH_MODE=storage-state \
AUTH_STATE_FILE=playwright/.auth/user.json \
TEST_EMAIL=your-test-identity@example.com \
TEST_PASSWORD=your-test-password \
  npx playwright test --project=setup
```

Run the workflow tests with the same `AUTH_MODE` and `AUTH_STATE_FILE`
values. The `api` project depends on `setup`, so the setup project runs first.

To re-authenticate, delete the state file and rerun the setup command:

```bash
rm -f playwright/.auth/user.json
AUTH_MODE=storage-state npx playwright test --project=setup
```

Common causes include expired tokens, changed login contracts, or revoked test
identities. Never use personal credentials, commit the state file, or upload it
as a CI artifact. Keep `playwright/.auth/` gitignored.
