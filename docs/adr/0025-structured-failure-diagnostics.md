# ADR-0025: Structured failure diagnostics

- Status: proposed
- Date: 2026-11-05

## Context

A failed AFK run used to end with one mutable string, `WorkflowRunner.runtimeErrorSummary`. It was the single carrier of "why did this fail", and it was overwritten at every failure site. The first failure's reason was destroyed by whatever came next — and what came next was often the agent's captured output rather than a reason.

Three failures from one week of PRD #27 runs, all with the same shape:

| Run | What the operator saw | What actually happened |
| --- | --- | --- |
| atlas#7 | `workflow crashed: <pnpm output>` | A pre-commit hook (husky → lint-staged → `scripts/typecheck-staged.mjs`) rejected the commit with 26 `TS2339` errors. The tail of the `pnpm` output had replaced the hook's reason. |
| k-base#9 | `No detailed failure reason recorded` | The QA agent was silent for 1800 s until the idle timeout fired. |
| console#4 | "QA agent 静默 1800s 超时" | The same silence, but with no timeout budget, no last known activity and no basis for the judgement. |
| open-api#2 | QA reported `qa_environment_missing` | A code defect: `RequestApiLimitFilter` read the entity stream first, so `ControlledEgressApi.java:102` read an empty servlet stream and three whitelisted POST endpoints forwarded an empty body (expected 27, actual 0). The environment probe turned an inference into a blocking declaration. |

The architecture underneath had three causes:

1. **One mutable string.** A failure fact was a string in a field, and a later failure overwrote it. There was no distinction between the root cause and what happened afterwards.
2. **Agent output and root cause in one string.** `formatExecutionFailure` joined `status`, `provider`, `runId`, `exitCode`, `error.message` and `structuredOutput` with `; `. But `error.message` for a non-zero exit is the provider's *captured process output* (`NON_ZERO_EXIT` sets it to `stderr || stdoutTail`). The symptom and the cause were the same text.
3. **The display layer did not ask.** `afk observe` printed `No detailed failure reason recorded` for an error event with no `reason`/`summary`/`failedCriteria` — without looking at the earlier `failure.classified` event in the same stream that did carry a summary. `run.finished` wrote the literal string `'workflow setup failed'` while the real message sat unused one line above.

A fourth cause sat in the environment probe: it inferred which tools existed from the use site and then treated the inference as a blocking declaration about the machine.

## Decision

### A structured failure diagnosis

The runtime gains a `FailureDiagnostic` (`packages/runtime/src/application/workflows/failure-diagnostic.ts`) with a `code`, a `class`, a `message`, a `cause` chain, `evidence`, and a `retryable` flag.

- `code` is stable and machine-readable. The vocabulary is `RunFailureReasonCode` in `@afk/core`, so a code can travel in an audit event without a second, drifting list.
- `class` says what the failure is about: `work`, `agent`, `upstream`, `environment`, `infrastructure`. This is the distinction an operator needs at a glance — our code is wrong, our agent went quiet, the model service is overloaded, this machine cannot run the check, AFK's own plumbing broke.
- `message` is the root cause in one human-readable sentence. It is never provider output.
- `evidence` carries the facts: probes with their command, expectation and observation; commands with their exit code; the truncated tail of the agent's output; the timeout budget, last known activity and the basis of the judgement.
- `cause` points back at the preceding failure. The chain is stored oldest-first, so the first failure is the root and every later failure is the next link.

### The first failure wins

`appendFailure` appends; it never replaces. `rootCause(chain)` is `chain[0]`. `runtimeErrorSummary` survives as a *derived* value — `renderFailureSummary(chain)` — so there is exactly one place where a failure fact lives. Every former assignment site now records a diagnostic instead.

The audit stream carries the same structure: `failure.classified` gains optional `code`, `cause` (a depth-limited snapshot of the preceding failure) and `evidence`; `run.finished` carries the root cause in `reason` and its code in `reasonCode`. The existing `failureClass` and `summary` fields are untouched, so existing consumers keep working.

### The agent's code vocabulary is reused, not replaced

`packages/runtime/src/domain/agents/failure.ts` already separated "the agent died" (`AGENT_TURN_FAILED`, `AGENT_GONE`, `AGENT_IDLE`) from "this says something about the work", and stated that a timeout is a fact about the work. That distinction is now carried upward: `classifyAgentFailure` maps each provider code to a kind, and the workflow layer reads that kind instead of inventing a parallel classification.

The provider's own code is preserved verbatim on the diagnostic as `providerCode`. A non-zero exit is special-cased: its message is captured output, so it is evidence, never a cause — and its error lines are lifted into the cause, which is what makes the atlas#7 hook rejection readable again.

Whether repeating an attempt is meaningful is read from the diagnosis. `isRetryableAgentFailure` is unchanged in meaning; it is now the single implementation behind `FailureDiagnostic.retryable`.

### Timeouts are first-class

`ExecutionResult` gains an optional `diagnostics` field carrying the timeout budget, the idle duration and the last known activity. The providers fill it in at the point where the timeout fires. The workflow layer turns it into `agent_idle_timeout`, `agent_completion_timeout` or `agent_hard_timeout`, each with the budget and the judgement basis in its evidence.

### An environment assertion is a declaration, not a verdict

`probeQaEnvironment` now records the probes it ran on each blocker: the command, whether it succeeded, and what it printed. A blocker is classified `environment_declaration_unsatisfied`, and the preflight's reason says so in words. The reader can tell "the tool is missing here" from "the acceptance criterion failed" without inferring it.

### The display layer asks

`formatEvent` takes the prior events explicitly and looks back for the nearest `failure.classified` / `qa.failed`, then walks the `cause` chain to the root. It prints `Cause: …` instead of a fixed phrase. `afk observe executions --json` lists the root cause of every failed execution (`failureSummary`, `failureCode`).

## Consequences

- A failed run now names one reason, and the reason survives. `afk log <runId>` shows it, `afk observe executions --json` shows it, and the backlog item carries it.
- The QA runner's failure code for a timeout is now the specific one (`agent_completion_timeout`) rather than the phase-level `qa_timeout`. `qa_timeout` remains in the vocabulary for compatibility.
- `afk observe` output grows: an error event that carries a diagnosis shows its code, its evidence and the cause chain.
- The failure chain is per-run state. It is bounded by the number of failures in a run, and the audit snapshot is depth-limited.
- A failure is now classified once and published once. An implementation that only sets the summary string no longer reports anything.

## Alternatives considered

- **Keep one string, truncate it better.** Rejected: it keeps the overwrite. The first failure is still lost to the second.
- **Parse the agent's output for a cause at display time.** Rejected: the parsing would live in the view layer, and the same output would be read differently by different readers.
- **Put the diagnosis type in `@afk/core`.** Rejected: the core package holds the event vocabulary and the domain model; the diagnosis is an application-level concept that renders runtime facts. Core keeps the event shape, the runtime owns the diagnosis.
