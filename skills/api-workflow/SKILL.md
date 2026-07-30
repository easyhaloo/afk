---
name: api-workflow
description: >-
  Use when user describes business scenarios like:
  - "test the full order flow: registration → login → create order → verify status"
  - "verify payment webhook end-to-end"
  - "test via API, then verify result in browser"
  - "check if user can checkout and payment is recorded correctly"
  - Any multi-step API testing or API+browser hybrid scenarios.
  Generates executable Playwright test files in the user's project.
---

# API Workflow Testing

**Goal:** Transform natural language business scenarios into executable Playwright test files.
**Tool:** Playwright
**Output:** Test files in user's project at `tests/api-workflow/`

## How to Use

1. **Parse** — Understand the user's scenario
2. **Generate** — Create test files in `tests/api-workflow/scenarios/`
3. **Confirm** — Show generated file structure
4. **Execute** — Run with `pnpm playwright test tests/api-workflow/`

## Generated Structure

```
tests/api-workflow/
├── scenarios/           # Business flow tests
│   ├── index.ts        # Re-exports all steps
│   └── order-flow.ts   # Example: order flow
├── fixtures/           # Reusable fixtures
│   ├── api-context.ts  # API context setup
│   └── test-data.ts    # Data lifecycle manager
├── utils/              # Utility functions
│   ├── auth.ts         # Authentication helpers
│   └── poll-until.ts   # Polling helpers
└── playwright.config.ts # Test configuration
```

## Templates Available

| Template | Purpose |
|---------|---------|
| `templates/scenarios/` | Step functions + flow tests |
| `templates/fixtures/` | API context, test data manager |
| `templates/utils/` | Auth, polling utilities |
| `templates/playwright.config.ts` | Test configuration |

## Pattern Index (references/)

### API Patterns (`references/api-patterns/`)

| Pattern | File |
|---------|------|
| Login, extract token | `auth-login.md` |
| CRUD lifecycle | `crud-resource.md` |
| Poll async job | `poll-until-complete.md` |
| Verify webhook | `verify-webhook.md` |
| Conditional branch | `conditional-flow.md` |
| Error validation | `expect-api-error.md` |
| Batch create/cleanup | `batch-operations.md` |

### Hybrid Patterns (`references/hybrid-patterns/`)

| Pattern | File |
|---------|------|
| API creates → Browser verifies | `api-setup-browser-verify.md` |
| Browser action → API verifies | `browser-action-api-verify.md` |
| API login → Browser session | `api-auth-browser-session.md` |
| Browser trigger → API poll | `browser-trigger-api-poll.md` |

### Examples (`references/examples/`)

| Example | Description |
|---------|-------------|
| `combined-flows.md` | Real-world scenarios combining patterns |

## Execution

```bash
# Run all API workflow tests
pnpm playwright test tests/api-workflow/

# Run specific scenario
pnpm playwright test tests/api-workflow/scenarios/order-flow.spec.ts

# Run with UI
pnpm playwright test tests/api-workflow/ --ui
```

## Anti-patterns

- **MUST NOT** execute without showing generated code first
- **MUST NOT** hardcode credentials — use environment variables
- **MUST NOT** skip assertions — every response needs validation
- **MUST NOT** forget cleanup — remove test data after tests
