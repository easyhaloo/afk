# Browser Auth Modes

Two modes for reusing browser authentication state in Playwright tests.
Pick the mode based on **where the test runs**, not on the auth scheme:

| Environment | Mode |
|-------------|------|
| **Local dev** — user runs Chrome 9222 with a dedicated profile, manually logged in | `localhost-cdp` |
| **CI** — no interactive login, scripted setup only | `storage-state` |

Never silently fall back between modes. The selected mode's fixture is
copied into the target project as `fixtures/browser-session.ts`.

## Mode Selection (Fail-Closed)

| Check | Decision |
|-------|----------|
| Is the execution environment CI? | Use `storage-state` (only safe choice) |
| Is there an already-running Chromium with a logged-in session? | `localhost-cdp` is viable |
| Is the browser Chromium and the endpoint loopback (`localhost`, `127.0.0.1`, `[::1]`)? | Required for `localhost-cdp` |
| None of the above fit safely? | **Stop and ask for a dedicated test identity** |

---

## `storage-state`

The deterministic default for CI. Authenticate once (via API or UI),
save the resulting cookies/localStorage/IndexedDB to a file, and load it
into isolated contexts for each test.

### Setup (one of the following, selected during generation)

**API setup** (`setup/auth-api.setup.ts`):
- Use `request.newContext()` to call the discovered login endpoint.
- Call `request.storageState({ path: AUTH_STATE_FILE })` to persist.
- Enable `indexedDB: true` only when the application stores auth tokens in
  IndexedDB (e.g., Firebase Authentication).

**UI setup** (`setup/auth-ui.setup.ts`):
- Navigate to the login page, fill credentials, submit.
- Wait for the post-login URL or stable authenticated UI element.
- Call `page.context().storageState({ path: AUTH_STATE_FILE })`.

### Generated Fixture

`fixtures/browser-session.ts` exposes `sessionContext` and `sessionPage`
as aliases for the Playwright built-in isolated context/page. The config
loads `AUTH_STATE_FILE` via `use.storageState`.

### Caveats

- `storageState` does not include `sessionStorage`. Applications that use
  `sessionStorage` for auth tokens must export/restore it manually via
  `page.evaluate()` and `addInitScript()`.
- IndexedDB requires `{ indexedDB: true }` (Playwright ≥ 1.51).
- Virtual WebAuthn credentials require `{ credentials: true }`
  (Playwright ≥ 1.61) and only work with Playwright-created virtual
  authenticators, not real hardware keys.
- `APIRequestContext.storageState()` and `BrowserContext.storageState()`
  are interchangeable.
- The state file is a credential. It must be in `playwright/.auth/` and
  gitignored. Delete and regenerate on expiry.

### Re-authentication

Delete the state file and re-run the setup project:

```bash
rm playwright/.auth/user.json
npx playwright test --project=setup
```

### CI Suitability

Yes. The setup project runs once before tests and the state file is
loaded by all dependent projects. No manual interaction is required.

---

## `localhost-cdp`

Attaches to an already-running Chromium instance over a loopback CDP
endpoint. The user starts the browser once with a dedicated profile and
remote debugging port; subsequent test runs reuse the live session.

### Prerequisites (User Runs Once)

```bash
# Start a dedicated Chrome (non-default user-data-dir is REQUIRED)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir=/Users/<user>/.afk-browser-profile \
  --remote-debugging-port=9222 \
  --no-first-run about:blank &
```

Then log in to every site the tests need in the launched browser. Login
state (cookies / localStorage / sessionStorage / IndexedDB) is persisted
in the profile directory and reused across runs without re-auth.

### Generated Fixture

`fixtures/browser-session.ts`:

- Reads `CDP_ENDPOINT` (required, default `http://127.0.0.1:9222`).
- Validates the endpoint: `http` or `ws` protocol, explicit port, no
  userinfo/query/hash, and host exactly `localhost`, `127.0.0.1`, or
  `[::1]`.
- Calls `chromium.connectOverCDP(endpoint, { noDefaults: true, timeout })`.
- Uses the existing default context (`browser.contexts()[0]`).
- Snapshots pre-existing pages; never closes them.
- Creates one test-owned `sessionPage` from the default context.
- On teardown: closes only the test-owned page, then closes the Playwright
  connection (`browser.close()`). The external browser and its pre-existing
  pages are untouched.
- **Rejects** CI, non-Chromium browsers, and non-loopback endpoints.

### Caveats

- CDP connections are Chromium-only and "significantly lower fidelity"
  than the Playwright protocol (official Playwright documentation).
- Chrome ≥ 136 requires a **non-default** `--user-data-dir` for remote
  debugging. Pointing at the default personal profile
  (`~/Library/Application Support/Google/Chrome`) is silently rejected
  with "DevTools remote debugging requires a non-default data directory".
  Always create a dedicated profile directory.
- Only one worker. No retries. No parallelism.
- The external browser process is owned by the user, not by Playwright.
- The CDP endpoint is a credential; do not log it, commit it, or expose
  it to non-loopback interfaces.
- The fixture borrows the existing context and pages. It must not close
  or navigate pre-existing pages. Test-owned pages must be closed in
  teardown.
- Session expiry, server-side revocation, step-up MFA, and device-bound
  sessions still apply. CDP reuses a currently valid session; it does not
  bypass authentication.

### Re-authentication

Re-authenticate in the external browser. The CDP connection picks up the
new session state on the next test run automatically.

### CI Suitability

No. Requires a pre-launched, manually authenticated browser. Reject in CI.

---

## State Sensitivity

Both modes produce artifacts that are functionally credentials:

| Artifact | Storage | Git |
|----------|---------|-----|
| `storage-state` JSON file | `playwright/.auth/` | gitignored |
| CDP endpoint | `CDP_ENDPOINT` env var | never committed |
| Persistent profile directory (user side) | outside repo | n/a |

Generated projects must include `.gitignore` entries for state file paths
and a `.env.example` with placeholder-only variable names.

## Discovery Checklist

Before selecting a mode, the skill must inspect:

1. **Auth storage**: cookies, localStorage, IndexedDB, sessionStorage?
2. **Playwright version**: supports `indexedDB` (≥1.51) and virtual
   WebAuthn credentials (≥1.61)?
3. **Login mechanism**: API endpoint discoverable? SSO/OAuth redirect?
   MFA? Passkey? CAPTCHA?
4. **Execution context**: CI or local? Headed browser available?
5. **Browser engine**: Chromium required for CDP.
6. **Existing state**: is there a pre-authenticated browser or profile?

When any check is ambiguous, **stop and ask**. Never guess.