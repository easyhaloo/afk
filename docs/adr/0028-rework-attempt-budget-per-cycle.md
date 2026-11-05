# ADR-0028: The QA rework budget belongs to a cycle, not to the item's life

- Status: accepted
- Date: 2026-11-05

## Context

PRD #27 had a slice, `gitlab:w.src.corp.qihoo.net/fang/web/atlas#7`, that failed QA for a real reason: the wiki migration left seven governance PNG assets behind. QA routed it to rework, the agent tried again, and the failures kept coming. After the budget was spent, the item sat in `blocked` with `mode::hitl` and the reason

```
QA rework attempt limit reached (9/3): QA FAIL: the wiki migration is functionally complete ...
```

A person then fixed the underlying defect — the missing PNGs were added — and ran the only recovery entry point AFK has:

```
afk backlog retry --id 7 --project ... --reason "the missing governance PNG assets are added"
```

The item went back to `rework`, the agent ran again, QA failed again — and the very same reason came back, with the same number:

```
QA rework attempt limit reached (9/3): ...
```

The count had never been reset. `afk backlog retry` was the only way out of a blocked item, and on this item it did nothing: the item could not be recovered by any CLI path even though the defect behind it had been fixed.

The cause was in `packages/runtime/src/domain/backlog/tracker-provider.ts`, where `createRework` derived the next attempt from everything the issue had ever carried:

```ts
const attempts = comments
  .map(parseReworkRecord)
  .filter(...)
  .map(entry => entry.record.attempt);
const attempt = (attempts.length ? Math.max(...attempts) : 0) + 1;
```

The rework history lives in the issue's comments, and a comment is never deleted — closing a record rewrites it in place, it does not remove it from the history. So `attempt` was the highest number the item had ever reached, plus one: 4, 5, 6, 7, 8, 9. The number in the message was a lifetime counter, and the limit was compared against it in `qa-runner.ts`:

```ts
const rework = active && active.attempt >= limit ? active : await this.providers.backlog.createRework(backlogId, record);
if (rework.attempt >= limit) { await this.markBlocked(...); }
```

`maxQaReworkAttempts` was meant to say *"do not let QA retry the same thing forever without a person deciding"*. What it actually said was *"this item may fail three times in its entire life"*. The budget was spent once and never returned, so the item was permanently blocked — a budget with no way to be renewed is not a budget but a tombstone.

## Decision

### A rework cycle is one round of fix-and-verify, and it owns the budget

The retry budget belongs to a **rework cycle**: one round of "fix it and verify it again" on an item. `maxQaReworkAttempts` bounds how many times AFK may try again inside one cycle before a person is asked.

A cycle is **opened by an operator intervention**, and by nothing else:

- `afk backlog retry` creates an operator rework record. The operator has answered the failure that ended the previous cycle and says that something changed — code, an instruction, the environment. The round that failed is over, and the next round starts with a full budget. This is the rule that makes the retry command mean what it says.
- A **QA failure** does not open a cycle. It is another try inside the round that is already running, and it spends that round's budget. Automatic retries therefore share one budget, which is the whole point of the limit: three tries by the machine, then a person.
- A **merge conflict** does not open a cycle either. It is the same round of work from a different angle, so it spends the same budget.

The first cycle is cycle 1 and is opened implicitly by the item's first rework record; an item that was never retried by a person therefore behaves exactly as before.

### The record says which cycle it belongs to

A rework record carries the cycle it belongs to and the attempt it spends inside it:

```ts
interface ReworkRecord {
  id: string;      // r<cycle>-<attempt>
  cycle: number;   // 1 is the first round of work
  attempt: number; // the retries this cycle has spent; 0 on the record that opens it
  ...
}
```

The operator record that opens a cycle spends no attempt, so it carries attempt 0 and the first QA failure of that cycle is attempt 1. A cycle therefore gets exactly the budget it would have had if no operator had ever touched the item.

The handle is `r<cycle>-<attempt>` so it stays unique inside the item and says what it refers to: `r2-1` is the first attempt of the second cycle.

### The count is derived from the running cycle only

The attempt of a new record is derived from the records of the cycle that is running now — the highest cycle in the history, and inside it the highest attempt. The rest of the history is read for the audit trail and nothing else:

```ts
export function nextReworkAttempt(records, source) {
  const running = records.reduce((highest, record) => Math.max(highest, record.cycle), 0);
  if (source === 'operator') return { cycle: running + 1, attempt: 0 };
  const cycle = running || 1;
  const spent = records.filter(record => record.cycle === cycle)
    .reduce((highest, record) => Math.max(highest, record.attempt), 0);
  return { cycle, attempt: spent + 1 };
}
```

Nothing is deleted: the comments of the previous cycles stay where they are, and a record that is closed keeps its place in the history. The difference is that a closed record no longer spends the budget of the rounds that follow it.

A record written before this decision carries no cycle. It is read as cycle 1 and keeps the attempt it was written with, so an item that already spent its budget stays over budget until an operator opens the next cycle — the defect is not papered over, it is recoverable.

### The reason says which round and how much of it is used

The failure message names the cycle and the attempts the cycle has spent:

```
QA rework attempt limit reached (cycle 2, 3/3 attempts used): QA FAIL: ...
```

A reader can tell "the third try of the second round" from "the ninth try ever", which is the difference between a budget that a person can spend on purpose and a number that only goes up.

## Consequences

- `afk backlog retry` unlocks the item it is given. A blocked item whose budget was spent comes back as `rework + afk` with a fresh budget, and the next QA failure is a rework instead of an immediate block.
- The budget is what it says it is: three tries by the machine per round of human involvement. The number of rounds is the number of times a person intervened, which is exactly the quantity an operator can control.
- An item that nobody ever retries behaves as before — cycle 1, the same three failures, the same block.
- The rework history keeps every record of every cycle, and each record now says which cycle it came from. The audit trail of "what failed, when, and in which round" is stronger than before, not weaker.
- The id of a rework record changed shape (`r3` → `r1-3`). It is an internal handle inside an issue comment, and the parser accepts both shapes, so a record written by the previous version still reads.

## Alternatives considered

- **Reset the counter when the item is retried, without naming the round.** Rejected: it fixes the symptom but leaves the number meaningless. The attempt count would jump back to 1 with nothing in the record saying which round it belonged to, and the next reader would have to guess why the history says 9 and then 1.
- **Count the attempts of the current cycle from the comments after the last operator record.** Rejected: it needs the comment order to be trustworthy, and the order a provider returns comments in is not a contract. The cycle number is written into the record, so the derivation does not depend on the order at all.
- **Let a QA failure open a new cycle as well.** Rejected: then the limit never bites. Every failure would arrive with a fresh budget, and `maxQaReworkAttempts` would be a number that exists but does nothing.
- **Give the operator retry its own budget counter, separate from the QA counter.** Rejected: two counters for one question. The budget that matters is the number of tries inside the round, and an operator retry is what starts a round.
- **Delete the comments of a spent cycle.** Rejected: the history is the audit trail. The record of what failed and why is worth more than a tidy counter.

## What this decision does not change

The scheduler counts the dispatches of an item **inside one scheduling session** (`scheduleWorkItems`), and it reads that count from its own map rather than from the rework records. It is a session budget, not the QA budget: it resets when the schedule is started again, and it is not what blocks an item in the provider. The two counters happen to share the `maxQaReworkAttempts` configuration value, which was already the case before this decision; splitting them is a separate change.
