# poll-until-complete

Poll an async job until completion or timeout.

## Concept

Submit an async task, then repeatedly query its status until it reaches a terminal state (COMPLETED, PAID, etc.) or timeout.

## Usage

Use `utils/poll-until.ts` from templates:

```typescript
import { pollUntil, pollOrderPaid, pollJobComplete } from '../utils/poll-until';

// Generic poll
const result = await pollUntil(apiContext, `/jobs/${jobId}`, data => data.status, ['COMPLETED']);

// Specialized polls
const order = await pollOrderPaid(apiContext, orderId);
const job = await pollJobComplete(apiContext, jobId);
```

## When to Use

- Payment processing (poll until PAID)
- File processing (poll until COMPLETED)
- Any async operation that changes status over time
