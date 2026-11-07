# batch-operations

Create or cleanup multiple resources at once.

## Concept

Create several related resources in a loop, track their IDs, then clean them up in reverse order.

## Usage

Use `fixtures/test-data.ts` from templates:

```typescript
import { TestDataManager } from '../fixtures/test-data';

const manager = new TestDataManager(apiContext);
const id = await manager.create('resource', { data });
await manager.cleanup();
```

## When to Use

- Creating multiple test products for an order
- Batch setup for complex scenarios
- Cleanup after tests
