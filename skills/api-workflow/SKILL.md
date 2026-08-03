---
name: api-workflow
description: >-
  Multi-step API testing with Playwright. Triggers: "test order flow", "verify webhook",
  "trigger async job, poll for completion", "API then browser verify". Generates
  executable test files from business scenarios.
---

# API Workflow Testing

**Tool:** Playwright | **Output:** `tests/api-workflow/` or standalone

## References

| Type | Path |
|------|------|
| Patterns | `references/api-patterns/` |
| Hybrid | `references/hybrid-patterns/` |
| Templates | `templates/` |

## Process

### 1. Discover

Analyze via codebase, NOT assumptions:

| Check | Action |
|-------|--------|
| Auth | Read middleware - X-API-Key / Bearer / Cookie? |
| Endpoints | Read route definitions |
| Async | Identify trigger + poll pattern |
| Freshness | Locate authoritative data source |
| Layout | Detect project structure (frontend repo? Playwright setup?) |

Layout is auto-detected during codebase analysis.

### 2. Clarify

Confirm with user:
- Detected layout and output location
- Workflow steps

### 3. Generate

Only after confirmation.

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

## Config

```typescript
baseURL: process.env.BASE_URL || 'http://localhost:8080'
testDir: '.'
'X-API-Key': process.env.WIKI_API_KEY
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
