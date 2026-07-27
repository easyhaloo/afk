---
name: reasoning-guard
description: >-
  Use when coding agent exhibits reasoning path failures during
  multi-turn coding sessions: error accumulation across iterations,
  repeated edits on the same location without convergence, excessive
  token consumption without measurable progress, or semantic regression
  where code quality degrades across edits.
  Detection is session-context-based (no hooks required); the agent
  applies correction prompts proactively within the current conversation.
  Also use when asked to "apply reasoning guard", "check my reasoning path",
  "stop and rethink", or "am I going in circles".
  Do NOT use when the agent is producing correct output steadily.
disallowed-tools: >-
  Edit(*) Agent(*) Task*(*)
  Bash(git push -f) Bash(git merge*) Bash(git reset --hard*)
  Bash(git branch -D*) Bash(docker*) Bash(rm -rf*)
---

# Reasoning Guard

**Goal:** Detect degraded reasoning paths in the current coding session
and inject corrective prompts before error accumulation compounds.

**Mode:** HITL within current session — the agent monitors its own
reasoning and self-intercepts when signals are detected. No hooks,
no background processes.

**Contract:** (none) → self-corrected session with reduced error compounding.

## What this skill is NOT

- NOT a hook-based automated system → use `reasoning-watchdog` for that
- NOT for single-step errors → focused on multi-turn accumulation failures
- NOT a replacement for good task decomposition → supplementary guard rails

## Detection Signals

The agent monitors these patterns conversationally:

| Signal | Pattern | Threshold |
|--------|---------|-----------|
| repeat_ops | Consecutive edits on same file location, each followed by lint/build failure | 3 consecutive |
| token_burn | Token consumption disproportionate to verified progress | subjective |
| semantic_regression | Code quality/scope shrinking across edits | subjective |
| combined | Multiple signals simultaneously | — |

Detection is based on conversation context: edit history, error message
patterns, and the agent's own assessment of whether progress is being made.

## Correction Prompt Structure

When a signal is detected, prepend to the next response:

```
[WATCHDOG INTERCEPT]
<Signal>: <Observation>

SAFE_RESTORE:
- git stash push -m watchdog-$(date +%Y%m%d%H%M%S)  # save current state
- git log --oneline -5  # identify stable baseline
- git reset --hard <hash>  # reset to clean baseline

FIRST_PRINCIPLES:
1. Assumption audit: which inputs are verified, which are inferred?
2. Backward chain from goal: what invariant is being maintained/broken?
3. Atomic breakdown: which write/side-effect is the true failure point?
4. Fix root cause only. Validate with minimal delta before committing.

CAUSAL_TRACE:
1. git log --oneline -10: identify session commits
2. git show --stat <hash> per commit: map changed files
3. git diff <hash>^..<hash>: inspect actual deltas
4. Trace from earliest failure commit: what introduced the regression?
5. git reset --hard <parent-hash>: revert to pre-failure state
6. Re-derive from clean state, not from failed delta

ADVERSARIAL:
1. Assume last change is wrong: list failure modes
2. Which 3 locations would a reviewer flag?
3. Find a counterexample to your current conclusion
4. Where would a different agent following this delta get stuck?
5. Propose a non-obvious alternative and compare boundary conditions

Continue only after completing the above analysis.
```

## Signal-Specific Observation Text

| Signal | Observation |
|--------|-------------|
| repeat_ops | "N consecutive edits on the same location with persistent errors. Delta is diverging." |
| token_burn | "Token rate exceeds apparent progress. Cost-benefit has diverged." |
| semantic_regression | "Code quality has degraded across edits. Scope is shrinking, not growing." |
| combined | "Multiple danger signals detected: repeat_ops + regression + token_burn." |

## Safe Restore Protocol

On interception, do NOT use `git stash pop`. Instead:

```
git stash push -m watchdog-$(date +%Y%m%d%H%M%S)  # save unconditionally
git log --oneline -5  # identify last stable commit
git reset --hard <stable-hash>  # reset to clean baseline
```

Rationale: `stash pop` can conflict and lose work. `stash push` + `reset --hard`
is deterministic and preserves the failed attempt for later analysis.

## Session Discipline Rules

1. **Self-monitoring**: continuously assess whether reasoning path
   is degrading, not just whether code compiles
2. **Early interception**: detect before 10+ consecutive failed attempts
3. **One intercept per episode**: after intercept, proceed under corrected
   framework. Do not re-intercept unless a new distinct failure mode emerges
4. **No false confidence**: lint pass ≠ correctness — assess functional intent
5. **Token awareness**: track whether spend is proportionate to verified progress

## Anti-patterns

- MUST NOT use `git stash pop` — only `stash push` + `reset --hard`
- MUST NOT intercept more than once per failure episode
- MUST NOT confuse lint pass with correctness
- MUST NOT skip interception when signals are present — discipline over momentum
