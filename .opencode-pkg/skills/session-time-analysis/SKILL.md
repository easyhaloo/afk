---
name: session-time-analysis
description: >-
  Analyze the current AI conversation or coding session to estimate where time
  was spent, identify bottlenecks and rework, and recommend evidence-based
  improvements. Use when asked for session duration, time distribution, workflow
  efficiency, or optimization recommendations.
license: MIT
---

# Session Time Analysis

**Goal:** Turn the current session's observable timeline and work artifacts into a time-distribution report with prioritized, evidence-based improvements.

## Steps

1. Inspect the available conversation timeline, tool/activity records, command output, test/build logs, CI timestamps, and task state. Use only sources available in the current session.
2. Classify work into requirements/clarification, investigation/planning, implementation, verification, debugging/rework, external or human wait, and unknown.
3. Separate measured durations, timestamp-derived intervals, estimates, and unknowns. Read `references/METHOD.md` before calculating or interpreting durations.
4. Reconcile overlapping activities; never sum overlapping wall-clock intervals as additive effort. Avoid treating gaps between messages as model execution time.
5. Identify the largest evidenced time sinks and their causes. Distinguish symptoms from root causes and tie each recommendation to an observation.
6. Report the distribution, confidence and data gaps, then rank practical improvements by expected impact and implementation cost. Follow `references/REPORT-TEMPLATE.md`.

## Constraints

- Never invent timestamps, tool durations, token costs, or percentages.
- If the transcript does not expose a session start time or activity durations, say so and provide only supported partial analysis.
- Do not claim a measured duration from message count, response length, or message gaps alone.
- Keep recommendations specific, testable, and proportionate to the evidence.
- Do not write files or modify project state unless explicitly requested.
- Respond in the user's language.
