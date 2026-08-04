# Browser Auth Modes

Three modes for reusing browser authentication state in Playwright tests.
Exactly one mode must be selected before generation; never silently fall
back between modes. The selected mode's fixture is copied into the target
project as `fixtures/browser-session.ts`.

## Mode Selection (Fail-Closed)

| Check | Decision |
|-------|----------|
| Auth endpoint discoverable, cookies/localStorage mappable? | `storage-state` is viable |
| SSO, MFA, passkeys, human login required? | `persistent-profile` or `localhost-cdp` |
| Is the execution environment CI? | Only `storage-state` is allowed |
| Is the browser Chromium? | Required for `localhost-cdp` |
| Is there an already-running Chromium with a logged-in session? | `localhost-cdp` is viable |
| None of the above fit safely? | **Stop and ask for a dedicated test identity** |

## `storage-state`

The deterministic default. Authenticate once (via API or UI), save the
resulting cookies/localStorage/IndexedDB to a file, and load it into
isolated contexts for each test.

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

### CI Suitability

Yes. The setup project runs once before tests and the state file is
loaded by all dependent projects. No manual interaction is required.

---

## `persistent-profile`

Launches a browser with a dedicated automation-only `userDataDir`.
Suitable for one-time manual SSO, MFA, passkey, or extension-based
authentication.

### Generated Fixture

`fixtures/browser-session.ts`:

- Reads `AUTH_PROFILE_DIR` (absolute path, required).
- Calls `chromium.launchPersistentContext(userDataDir, { headless: false })`.
- Uses worker scope for the owned context and browser.
- Creates a test-scoped `sessionPage`.
- On teardown: closes only the owned page, then closes the owned context
  (which also closes the browser). Preserves the profile directory.
- **Rejects** CI, known default personal Chrome profile paths, and
  concurrent use of the same directory.

### Setup (Manual, One-Time)

1. Run `AUTH_PROFILE_DIR=/path/to/playwright-profile npx playwright test --headed`
   with a temporary test that pauses for manual login.
2. Complete SSO/MFA/passkey login in the launched browser window.
3. Close the browser. The profile directory now holds the authenticated
   session.
4. Subsequent test runs reuse the profile without re-authentication.

### Caveats

- Chromium/Chrome: do not point `userDataDir` at the default personal
  Chrome profile (`~/Library/Application Support/Google/Chrome`). Create
  an empty directory instead.
- The same `userDataDir` cannot be used by two concurrent browser
  instances.
- The browser is launched by the fixture, not by the user beforehand.
- Only one worker is allowed; parallelism and retries must be disabled
  in the generated config.
- The entire profile directory is a credential. It must be gitignored and
  never uploaded as a CI artifact.

### CI Suitability

No. Requires a headed browser and manual login. Reject in CI.

---

## `localhost-cdp`

Attaches to an already-running Chromium instance over a loopback CDP
endpoint. The user must have started the browser with a dedicated
`--user-data-dir` and `--remote-debugging-port` before running tests.

### Generated Fixture

`fixtures/browser-session.ts`:

- Reads `CDP_ENDPOINT` (required).
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

### Setup (Manual, One-Time)

```bash
# Start Chromium with a dedicated profile and remote debugging
/path/to/chromium \
  --user-data-dir=/path/to/playwright-profile \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1
```

Log in manually in the launched browser. Then set `CDP_ENDPOINT`:

```bash
export CDP_ENDPOINT=http://127.0.0.1:9222
```

### Caveats

- CDP connections are Chromium-only and "significantly lower fidelity"
  than the Playwright protocol (official Playwright documentation).
- Chrome ≥ 136 requires a non-default `--user-data-dir` for remote
  debugging. The personal Chrome default profile cannot be debugged
  this way.
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

### CI Suitability

No. Requires a pre-launched, manually authenticated browser. Reject in CI.

---

## State Sensitivity

All three modes produce artifacts that are functionally credentials:

| Artifact | Storage | Git |
|----------|---------|-----|
| `storage-state` JSON file | `playwright/.auth/` | gitignored |
| Persistent profile directory | `AUTH_PROFILE_DIR` | gitignored |
| CDP endpoint | `CDP_ENDPOINT` env var | never committed |

Generated projects must include `.gitignore` entries for all three
artifact paths and a `.env.example` with placeholder-only variable names.

## Expiry and Re-Authentication

- `storage-state`: delete the state file and re-run the setup project.
- `persistent-profile`: re-launch with the same profile directory and
  complete the manual login flow again.
- `localhost-cdp`: re-authenticate in the external browser.

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