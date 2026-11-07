# ADR-0034: A temporary failure is not a permanent failure

- Status: accepted
- Date: 2026-11-06

## Context

On 2026-11-06 at 09:41 the scheduler that was driving PRD #27 died:

```
schedule inventory is incomplete: fetch failed
```

One fetch did not make it through the network, and the process that was supposed to be watching twenty-one slices was gone. Nothing was retried, nothing was backed off, and no work item was reported as blocked — the PRD simply stopped moving, and the only evidence was a line in a log nobody was watching.

The cause was one statement. `packages/runtime/src/application/runners/scheduler.ts` read the provider inventory at the top of its loop:

```ts
while (!options.signal?.aborted) {
  const items = await read();
```

`read()` throws when the inventory is incomplete, and the throw escaped the loop, the command, and the process. The scheduler had exactly one reading of the world: a world it could not see was a world that did not exist.

### Why a failed read is not a verdict

The scheduler polls a remote provider. Everything it knows about the PRD comes across a network, and that network fails for reasons that have nothing to do with the PRD: a proxy restarting, a VPN renegotiating, a moment of packet loss. The inventory is a *fact about the world*, and the fetch is a *request for that fact*. One failed request says that the request failed. It says nothing about the next one.

Collapsing the two is what turned a momentary hiccup into a dead process. The scheduler is the component whose entire job is to keep looking — it is the thing that survives a slow slice, a human merge gate, and a machine under load. A scheduler that dies on the first error is a scheduler that cannot do its job.

## Decision

**A temporary failure is not a permanent failure. AFK retries, backs off, and says so.**

### A failed inventory read does not end the scheduler

The read is now inside the loop's own error handling. A failure increments a counter, the scheduler waits, and the loop continues:

```ts
try {
  items = await read();
} catch (error) {
  inventoryFailures += 1;
  const retryInMs = inventoryBackoffMs(inventoryFailures, pollInterval);
  logger.warn({ parent, failures: inventoryFailures, retryInMs, error: message },
    'schedule inventory is unavailable; the scheduler is still running and will retry');
  options.onStatus?.({ ..., inventoryUnavailable: { failures, error, retryInMs } });
  await wait(retryInMs, options.signal);
  continue;
}
```

The counter is reset by the first read that succeeds, so an outage that lasts an hour and then clears does not leave the scheduler backing off for the rest of the day.

### The backoff starts at the poll interval and has a ceiling

The first retry waits one poll interval — the rhythm the scheduler already keeps between two evaluations. Every further failure doubles the wait, up to five minutes. A provider that is down for an hour must not turn into a request every second, and a provider that comes back must not have to wait an hour to be noticed.

### Being alive but blind is said out loud

A scheduler that cannot see the work items is not a scheduler with nothing to do, and the two must not look alike to the person watching it. So the failure is not silent:

- the run log carries the diagnostic, the failure count, and the delay before the next attempt;
- the command line says that the inventory is unavailable, that the scheduler is still running, and when it retries;
- the status callback carries the same information, so any other consumer can see it too.

Silence was the real defect here. A scheduler that had died loudly would have been found in a minute; one that died quietly took a person to notice that a PRD had stopped moving.

## Consequences

- A network blip no longer takes the PRD down with it. The scheduler keeps its cadence and resumes as soon as the provider answers.
- The failure is legible while it lasts: the log says how many attempts have failed and when the next one is due.
- A provider that is *permanently* unreachable keeps the scheduler alive instead of letting it exit. That is deliberate: the operator can see the diagnostics and fix the cause, and a scheduler that exits leaves nothing to read.
- The scheduler no longer distinguishes "the provider said no" from "the network said no" at the exit. It distinguishes them in the log instead, which is where an operator looks.

## Alternatives considered

- **Exit on the first failed read, as before.** Rejected: it turns a recoverable network event into a dead process, and it is the reason the PRD stopped moving on 2026-11-06.
- **Retry immediately, without a backoff.** Rejected: a provider that is down would be hammered at the scheduler's own request rate, and the failure would look like a load problem rather than an outage.
- **Retry a fixed number of times, then exit.** Rejected: it picks an arbitrary moment to give up. The provider's health is not AFK's to guess, and the operator is the one who can tell a provider outage from a misconfiguration.
- **Treat an incomplete inventory as an empty inventory.** Rejected: an empty PRD and an unreadable PRD look the same to every downstream rule, so the scheduler would report "nothing to do" for a PRD that was full of work — the same silence this ADR exists to end.
