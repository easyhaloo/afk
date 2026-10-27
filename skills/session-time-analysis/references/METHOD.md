# Time Analysis Method

## 1. Evidence classes

Use these labels for every reported duration:

- **Measured** — explicit start/end or duration from a tool, task runner, test report, build log, CI job, or workflow event.
- **Timestamp-derived** — computed from two explicit timestamps for the same activity or a clearly bounded interval.
- **Estimated** — inferred from partial evidence or user-provided estimates. State the assumption and confidence.
- **Unknown** — the available session data cannot support a defensible value.

Never upgrade an estimate to measured time. Message count, response length, number of tool calls, and gaps between messages are not duration measurements.

## 2. Classification

Assign each non-overlapping activity interval to one primary category:

| Category | Includes |
|---|---|
| Requirements | Clarification, acceptance criteria, scope decisions |
| Investigation | Reading code/docs, searching, architecture analysis |
| Planning | Task breakdown, sequencing, implementation plan |
| Implementation | Editing, coding, configuration changes |
| Verification | Unit/integration/E2E tests, lint, typecheck, build |
| Debugging / rework | Diagnosing failures, corrective edits, repeated verification, rollback |
| External / human wait | CI queue/runtime, network/provider wait, approval, user response when explicitly observable |
| Unknown | Activity with insufficient evidence for classification |

Use a separate **wait/active** dimension when evidence supports it. Do not force idle time into an active-work category. A single activity can have a primary category and a secondary tag, but it must not be counted twice in totals.

## 3. Duration rules

1. Prefer explicit duration fields from tool output or logs.
2. Otherwise calculate end timestamp minus start timestamp only when both timestamps bound the same activity.
3. Message-to-message gaps are **elapsed gaps**, not AI execution time. Report them separately only when relevant, and never assign them to active work without evidence.
4. For overlapping tool calls or parallel agents, report wall-clock span and summed task durations separately. Do not add overlapping intervals to a single wall-clock total.
5. Report a category share only when the numerator and denominator use the same time basis and coverage. Label partial coverage clearly.
6. If the session has no reliable start/end or activity timestamps, report that total duration and percentages are unavailable. Continue with a qualitative bottleneck analysis where evidence permits.
7. Round estimates to a sensible precision; avoid false precision such as seconds or decimal percentages from coarse evidence.

## 4. Bottleneck diagnosis

For each significant cost, record:

- **Observation:** the concrete event, failure, wait, duplicate action, or missing information.
- **Impact:** measured/estimated duration, repeated attempts, blocked work, or delivery risk.
- **Likely cause:** distinguish confirmed causes from hypotheses.
- **Recommendation:** a specific workflow or technical change.
- **Validation:** a metric or observable condition that would show improvement.

Prioritize in this order unless evidence suggests otherwise:

1. Repeated failures or avoidable rework.
2. Long external waits that can be overlapped or shortened.
3. Repeated discovery/context gathering.
4. Serial work that has independent parts suitable for parallel execution.
5. Excessive process or reporting overhead.

Do not recommend parallelization when tasks share mutable state, depend on each other's results, or parallel execution would add coordination overhead.

## 5. Confidence

- **High:** direct durations or complete activity timestamps.
- **Medium:** partial timestamped evidence with explicit, limited assumptions.
- **Low:** qualitative inference without reliable duration measurements.

Confidence applies to the specific finding, not to the entire report. Explain the missing evidence that limits confidence.
