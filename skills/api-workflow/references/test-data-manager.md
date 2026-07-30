# test-data-manager

Test data lifecycle: create → use → cleanup.

## Concept

Create resources during test setup, use them in tests, automatically clean them up in test teardown. Prevents test data pollution.

## Usage

```typescript
import { TestDataManager } from '../fixtures/test-data';

const manager = new TestDataManager(apiContext);

try {
  const userId = await manager.create('users', { name: 'Test' });
  const orderId = await manager.create('orders', { userId });
  // ... use test data
} finally {
  await manager.cleanup();
}
```

## When to Use

- Every test that creates resources
- Prevent data pollution between tests
- Ensure tests can run in any order
