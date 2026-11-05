# ADR-0027: The scheduler re-evaluates on a timer, and says why it waits

- Status: accepted
- Date: 2026-11-05

## Context

PRD #27 was scheduled with a capacity of four:

```
afk schedule --parent gitlab:.../llm-wiki#27 --max-concurrent 4 --load-limit 16 --poll-interval 30000
```

One slice started. The other four were `rework`, in four different repositories, with no lease in common — and none of them was ever dispatched. The machine ran at a load of 5 to 12 against an idle baseline of 12, well under the limit of 16. Three of the four slots stayed empty for the better part of an hour.

The cause was one branch of one loop. `packages/runtime/src/application/runners/scheduler.ts` ended its dispatch pass with:

```ts
if (active.size) {
  await Promise.race([...active.values()].map(entry => entry.promise));
  continue;
}
```

`Promise.race` over the in-flight executions and nothing else. While any execution ran, the scheduler had exactly one reason to wake up: that execution finishing. The poll interval lived in the branch below it — the one that runs when nothing is in flight — so `--poll-interval 30000` never started a timer while work was running. A capacity of four with one slice in flight was therefore a capacity of one, and the PRD moved at the speed of its slowest slice instead of at the speed of the capacity the operator asked for.

Two more facts made the defect hard to see:

- **The help promised a timer that did not exist.** `--poll-interval` was documented as the "refresh interval while paused or watching", and `--watch` as "keep watching for merged dependencies and operator retries". A merge that landed while another slice ran stayed invisible until the scheduler happened to be idle, because the only wake-up was the end of an execution.
- **The report did not say why anything waited.** Every waiting item carried the runnability rules and nothing else. "Waiting for capacity" and "waiting for a dependency that nobody merged" are different problems with different owners, and both were reported as the same silence — so "four items did not start" looked like a scheduler that was too slow, while the truth might have been a capacity that was full, a host that was overloaded, or a dependency that needed a person.

## Decision

### The loop wakes on two events: an execution ends, and the poll interval elapses

The dispatch pass now races the in-flight executions against a cancellable timer:

```ts
await awaitDispatchDecision(active, pollInterval, options.signal, wait);
```

The timer is tied to the caller's abort signal and to a controller the helper owns, and it is cancelled the moment the race is decided. An abandoned timer must neither keep the process alive nor fire a poll nobody waits for. A cancelled timer is the ordinary way the wait ends; only a genuine failure of the wait itself is rethrown.

The timer is the reason idle capacity is usable. When the scheduler looks again and a slot is free and something is dispatchable, it dispatches — within one poll interval, not at the end of the slowest slice. Idle capacity is wasted capacity, and wasted capacity is a PRD that ships late.

### `--watch` runs until it is stopped

The watch loop used to break as soon as the waiting list ran empty, which is the opposite of what the help promises. A watch now keeps running until it is stopped: it keeps polling for merged dependencies, for operator retries, and for work that appears later. Without `--watch` the schedule stays one-shot — it ends once the current wave has dispatched everything it can — and the dispatch pass runs on every iteration, so "the wave is over" means "nothing more can be dispatched", not "nothing more was looked at".

### The report says which constraint binds

Every waiting item now carries a `waitReason`:

| Reason | Meaning |
| --- | --- |
| `dependency_not_ready` | A dependency has not finished. |
| `capacity_full` | Every execution slot is taken. |
| `repository_busy` | Another execution holds one of this item's repository leases. |
| `system_overloaded` | The host is above the load limit. |
| `awaiting_human` | A person has to act: a merge, a blocked item, an operator retry. |
| `attempt_limit_reached` | The rework budget is spent. |
| `not_executable` | AFK does not execute this item. |

The field is optional and additive. The runnability rules are untouched, and a report written before the field existed still parses.

The order in which the constraints are consulted is itself the contract: a missing dependency outranks everything, because no amount of free capacity starts an item whose dependency is not merged; a taken slot outranks the machine load, because a slot that is occupied is the reason the item waits even on an idle machine; the load comes last, because it is the one constraint that clears on its own.

## Consequences

- A schedule with capacity four and one slice in flight fills the other three slots as soon as their slices become dispatchable.
- `--watch` no longer ends by itself. An operator who wants a one-shot schedule does not pass the flag; an operator who wants a watch stops it with SIGINT, as the help says.
- The poll interval is now a real cadence in both modes, and it also sets how often the scheduler re-reads the provider inventory. On a long run that is a provider call per interval, which is a cost the operator chooses with `--poll-interval`.
- "Four items are waiting" is now an answerable question: the report says whether the capacity is full, the host is loaded, a lease is held, or a dependency is not merged.

## Alternatives considered

- **Wake the scheduler only when an execution ends, and let the operator restart it.** Rejected: the idle slots stay idle for exactly as long as the slowest slice, and the operator cannot see that from the report — the report said "waiting" for every one of them.
- **Start a fresh timer for every waiting item.** Rejected: the poll interval is a cadence for the schedule, not a per-item timer. One timer per evaluation is the same information at a fraction of the provider traffic.
- **Dispatch everything that is runnable, ignoring the capacity.** Rejected: the capacity is what keeps concurrent executions from overloading the machine and from contending for the same repository lease.
- **Keep `--watch` ending when the waiting list runs empty.** Rejected: that is the behaviour the help text contradicts, and it makes the watch flag depend on the shape of the backlog rather than on the operator's intent.
- **Fold the wait reason into the runnability rules.** Rejected: runnability answers "may this item start", which is a property of the item. Capacity, load, and leases are properties of the host, and the runnability rules are shared with the loop, the command line, and the desktop client — they must not grow a notion of the host.
