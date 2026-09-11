---
name: api-workflow
description: >-
  Multi-step API testing with Playwright. Generates executable test files from
  business scenarios with auth reuse. Pick the auth mode by where the test
  runs: local dev uses a long-running Chrome on 9222 + CDP attach (default);
  CI uses storage-state from API login. Triggers: "test order flow",
  "verify webhook", "trigger async job, poll for completion",
  "API then browser verify", "reuse browser login", "skip UI login",
  "browser auth session".
---

# API Workflow Testing

**Tool:** Playwright | **Output:** `tests/api-workflow/` or standalone

## References

| Type | Path |
|------|------|
| Patterns | `references/api-patterns/` |
| Hybrid | `references/hybrid-patterns/` |
| Auth modes | `references/hybrid-patterns/browser-auth-modes.md` |
| Templates | `templates/` |

## Process

### 1. Discover

Analyze via codebase, NOT assumptions:

| Check | Action |
|-------|--------|
| Auth | Read middleware — X-API-Key / Bearer / Cookie? |
| Auth storage | cookies, localStorage, IndexedDB, or sessionStorage? |
| Login mechanism | API endpoint discoverable? SSO/OAuth? MFA? Passkey? |
| Endpoints | Read route definitions |
| Async | Identify trigger + poll pattern |
| Freshness | Locate authoritative data source |
| Layout | Detect project structure (frontend repo? Playwright setup?) |
| CI/local | Is this running in CI or locally? |

Layout is auto-detected during codebase analysis.

### 2. Pick Auth Mode (Environment-Driven)

Pick the mode based on **where the test will run**, not on the auth scheme:

| Environment | Mode |
|-------------|------|
| **Local dev** — user already runs Chrome on 9222 with a dedicated profile, manually logged in | `localhost-cdp` |
| **CI** — no interactive login, fully scripted | `storage-state` |

Don't ask the user which mode to pick when the environment is obvious. The
auth scheme (SSO, MFA, passkey, etc.) only matters when generating the
storage state file in CI, not when picking the mode itself.

**Hard rejects:**
- Reject `localhost-cdp` in CI (no manual browser available).
- Reject `localhost-cdp` for non-Chromium browsers or non-loopback endpoints.
- When neither mode fits, stop and ask for a dedicated test identity.

### 3. Clarify

Confirm with user:
- Detected layout and output location
- Selected browser auth mode
- Workflow steps (auth setup, API calls, browser verification)

### 4. Generate

Only after confirmation. Copy only the selected mode's fixture, setup,
and config artifacts. Never generate unused modes.

## Output Options

**A: Inside frontend repo** (if Playwright setup detected)
```
frontend/e2e/api-workflow/
|-- scenarios/*.spec.ts
|-- fixtures/
|-- utils/
# Reuse root playwright.config.ts
```

**B: Standalone project** (if no frontend or external tester)
```
tests/api-workflow/
|-- package.json
|-- playwright.config.ts
|-- scenarios/*.spec.ts
|-- fixtures/
|-- utils/
```

## Auth Mode Artifacts

When a browser auth mode is selected, the generated project also receives:

| Artifact | Source template |
|----------|----------------|
| `fixtures/browser-session.ts` | Selected mode fixture (`localhost-cdp` or `storage-state`) |
| `setup/auth-api.setup.ts` (storage-state only) | API setup to generate state file |
| `playwright/.auth/` (gitignored) | Auth state file location |
| `.gitignore` entries | `templates/auth-artifacts.gitignore` |
| `.env.example` | `templates/auth.env.example` |
| `browser-auth-runbook.md` | Setup and re-auth instructions |

## Config

```typescript
baseURL: process.env.BASE_URL || 'http://localhost:8080'
testDir: '.'
'X-API-Key': requireEnv('WIKI_API_KEY')
```

## Async Pattern

```
POST /action -> { run_id }
GET  /runs/:id (poll) -> { status, summary }
```

Poll endpoint `summary` often more authoritative than cached GET.

## Anti-patterns

- No hardcoded credentials / base URL
- No `.spec.ts` suffix missing
- No skipping codebase analysis / user confirmation
- No silent fallback between auth modes
- No generating unused auth mode artifacts