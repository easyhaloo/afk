# API Testing Pitfalls

Common mistakes in API workflow tests and how to avoid them.

## 1. Configuration Issues

### Wrong testDir Path

```typescript
// WRONG: If config is in frontend/e2e/api-workflow/
testDir: './tests/api-workflow'  // Looks for ./tests/api-workflow/**/*.spec.ts

// CORRECT: Points to current directory
testDir: '.'
```

### Hardcoded Base URL

```typescript
// WRONG
baseURL: 'https://api.example.com'

// CORRECT: Environment variable with fallback
baseURL: process.env.BASE_URL || 'http://localhost:8080'
```

## 2. Naming Issues

### Missing `.spec.ts` Suffix

```bash
# WRONG: Playwright won't find these
lint-flow.ts
review-flow.ts

# CORRECT: Must end with .spec.ts
lint-flow.spec.ts
review-flow.spec.ts
```

## 3. Async Data Issues

### Assuming Cached Data is Fresh

Some GET endpoints return cached responses that may be stale:

```typescript
// WRONG: Some endpoints return cached issues that may be empty
const report = await apiContext.get('/some-report');
console.log(report.issues.length); // May be 0!

// CORRECT: Use the async run's summary for accurate counts
const run = await pollLintRun(apiContext, runId);
console.log(run.summary.orphan); // Accurate
```

### Not Accounting for Async State

```typescript
// WRONG: Immediately checking status after trigger
await apiContext.post('/some-async-action');
const status = await apiContext.get('/runs/latest');
// Status might still be "running"!

// CORRECT: Poll until terminal state
const run = await pollUntil(apiContext, `/runs/${runId}`,
  data => data.status,
  ['completed', 'failed'],
  { intervalMs: 1000, timeoutMs: 30000 }
);
```

## 4. Test Isolation Issues

### Shared Mutable State

```typescript
// WRONG: Module-level mutable state causes flaky tests
let apiContext: APIRequestContext;

test.beforeAll(async ({ playwright }) => {
  apiContext = await playwright.request.newContext({...});
});

test('test1', async () => {
  // If test1 fails and retries, apiContext may be in bad state
});

// CORRECT: Add null checks and handle cleanup
let apiContext: APIRequestContext | null = null;

test.beforeAll(async ({ playwright }) => {
  apiContext = await playwright.request.newContext({...});
});

test.afterAll(async () => {
  if (apiContext) {
    try {
      await apiContext.dispose();
      apiContext = null;
    } catch (e) {
      // Ignore - may already be closed
    }
  }
});

function getApiContext(): APIRequestContext {
  if (!apiContext) throw new Error('Context not initialized');
  return apiContext;
}
```

## 5. Assertion Issues

### Weak Assertions

```typescript
// WRONG: No actual verification
const res = await apiContext.get('/some-data');
const data = await res.json();
console.log(data.issues); // Just logging!

// CORRECT: Verify response structure
expect(res.ok()).toBe(true);
expect(Array.isArray(data.issues)).toBe(true);
expect(data).toHaveProperty('items');
```

## 6. Environment Issues

### Hardcoded Credentials

```typescript
// WRONG
headers: { 'X-API-Key': 'dev-api-key-12345' }

// CORRECT: Use environment variables
headers: { 'X-API-Key': process.env.WIKI_API_KEY || 'dev-api-key-12345' }
```

## Pre-Generation Checklist

**IMPORTANT:** These steps MUST be completed BEFORE any code generation:

### Step 1: Codebase Analysis
```
- Read router.go to find actual endpoint definitions
- Identify HTTP method and path for each operation
- Find authentication requirements in middleware
- Identify response structs and field names
```

### Step 2: Workflow Clarification
```
- Map out the complete workflow step by step
- Identify which endpoints are sync vs async
- Determine where authoritative data lives
- Confirm with user before proceeding
```

### Step 3: Environment Check
```
- Verify testDir path based on config location
- Confirm base URL via env var
- Ensure credentials via env var
```
