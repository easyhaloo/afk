---
name: api-workflow
description: >-
  Multi-step API testing with Playwright. Triggers: "test order flow", "verify webhook",
  "trigger async job, poll for completion", "API then browser verify", "reuse browser login",
  "skip UI login", "browser auth session". Generates executable test files from business
  scenarios with authenticated browser session reuse.
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

### 2. Select Browser Auth Mode

If the user needs authenticated browser sessions, select exactly one mode
from `references/hybrid-patterns/browser-auth-modes.md`. Base the selection
on the Discover checks above, then confirm with the user before generating.

| Mode | When | CI? |
|------|------|-----|
| `storage-state` | Auth endpoint discoverable, deterministic default | Yes |
| `persistent-profile` | SSO, MFA, passkey, manual login required | No |
| `localhost-cdp` | Already-running Chromium, explicit user opt-in | No |

**Fail-closed rules:**
- Never silently fall back between modes.
- Reject `persistent-profile` and `localhost-cdp` in CI.
- Reject `localhost-cdp` for non-Chromium browsers or non-loopback endpoints.
- When no safe mode fits, stop and ask for a dedicated test identity.

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
| `fixtures/browser-session.ts` | Selected mode fixture |
| `setup/auth-*.setup.ts` | API or UI setup (storage-state only) |
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