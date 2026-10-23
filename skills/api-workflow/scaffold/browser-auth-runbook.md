# Browser Auth Runbook

Two modes. Pick by environment:

| Runs where | Mode | Setup |
|------------|------|-------|
| **Local dev** | `localhost-cdp` | One-time: launch a dedicated Chrome with `--remote-debugging-port=9222`, log in |
| **CI** | `storage-state` | One-time: run setup project to generate `playwright/.auth/user.json` |

---

## localhost-cdp (local dev)

The default for human-driven development. You start a Chrome once, log in
to the sites you need, and leave it running on port 9222. Tests attach
over CDP and reuse the live session — no per-run login.

### One-time setup

```bash
# 1. Create a dedicated profile (NEVER point at the default personal profile)
mkdir -p ~/.afk-browser-profile

# 2. Launch Chrome with remote debugging
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir=$HOME/.afk-browser-profile \
  --remote-debugging-port=9222 \
  --no-first-run about:blank &

# 3. In the launched Chrome, log in to every site the tests need.
#    Cookies / localStorage / sessionStorage / IndexedDB are persisted.

# 4. Set the endpoint for the test runner
export CDP_ENDPOINT=http://127.0.0.1:9222
```

### Re-authentication

Just re-login in the running Chrome. The next test run picks up the new
session state automatically — no setup project to re-run.

### If Chrome is killed / restarted

Re-run step 2 above. The profile (`~/.afk-browser-profile`) persists
sessions across restarts, so you usually stay logged in.

### Security

- The CDP endpoint is a credential. Bind to loopback only (the default).
- Never commit `CDP_ENDPOINT` or the profile directory.

---

## storage-state (CI)

For scripted environments with no interactive browser. Tests load a
pre-generated auth state file.

### One-time setup

```bash
# Run the setup project to generate the auth state file
AUTH_STATE_FILE=playwright/.auth/user.json \
TEST_EMAIL=your-test-email@example.com \
TEST_PASSWORD=your-test-password \
  npx playwright test --project=setup
```

The setup project calls the discovered login endpoint (or fills the UI
login form), then writes the resulting cookies/localStorage to
`playwright/.auth/user.json` (gitignored).

### Re-authentication

Delete the state file and re-run setup:

```bash
rm playwright/.auth/user.json
npx playwright test --project=setup
```

Typical triggers for re-auth:
- Auth tokens in the state file expired (e.g., short-lived JWT).
- Login API contract changed.
- Test identity was revoked.

### Security

- `playwright/.auth/user.json` is a credential. Keep it gitignored.
- Use a dedicated test identity, never a personal account.
- Never upload the state file as a CI artifact (or encrypt it first).