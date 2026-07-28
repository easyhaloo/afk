---
name: reasoning-watchdog
description: >-
  Automated hook-based reasoning path guard for coding agents.
  Installs PostToolUse/PreToolUse/SessionEnd hooks into Claude Code
  to detect error accumulation and intercept before damage compounds.
  Use when the reasoning-watchdog system is already installed
  (npm run install completed) and you need to check status,
  tune thresholds, or troubleshoot.
  Do NOT use for session-context-based reasoning monitoring — this
  skill is hook-based, not conversation-based.
disallowed-tools: >-
  Edit(*) Agent(*) Task*(*)
  Bash(git push -f) Bash(git merge*) Bash(git reset --hard*)
  Bash(git branch -D*) Bash(docker*) Bash(rm -rf*)
---

# Reasoning Watchdog (Hooks Version)

**Goal:** Automated detection and interception of degraded reasoning
paths during Claude Code sessions via hook scripts.

**Mode:** AFK — hooks run unattended after install. This skill manages
the install/uninstall/status lifecycle.

**Contract:** installed hooks → intercepted sessions receive corrective prompts.

## What this skill is NOT

- NOT session-context-based reasoning monitoring — this skill works via
  hooks only, with no agent self-monitoring
- NOT for manual reasoning checks during conversation — the agent does
  not apply corrections interactively
- NOT a fix for single-step reasoning errors — focused on multi-turn
  accumulation failures

## Architecture

```
Claude Code session
  └── PostToolUse hook  → reasoning-watchdog detects error signals
        ├── repeat_ops: N consecutive edits on same location with errors
        ├── token_burn: token rate > threshold
        └── semantic_regression: quality score below baseline

  └── PreToolUse hook   → injects corrective prompt + blocks next action
        ├── SAFE_RESTORE: git stash push + git reset --hard
        ├── FIRST_PRINCIPLES: assumption audit + root cause breakdown
        ├── CAUSAL_TRACE: git log/diff trace to root-cause commit
        └── ADVERSARIAL: failure mode enumeration + counterexample search

  └── SessionEnd hook   → cleanup session state files
```

## Install / Uninstall

```bash
cd ~/.claude/reasoning-watchdog

npm run install     # register hooks in ~/.claude/settings.json
npm run uninstall   # remove hooks from ~/.claude/settings.json
npm run cleanup     # remove orphaned state files
```

Install is idempotent — running twice does not duplicate hook entries.
Uninstall removes only watchdog hooks, leaves all other settings intact.

## Detection Signals

| Signal | Trigger Condition | Default Threshold |
|--------|-------------------|-------------------|
| repeat_ops | N consecutive edits on same file location, each followed by lint/build failure | N=3 |
| token_burn | tokens/min consumed in session | 5000 tokens/min |
| semantic_regression | static analysis score drop vs previous snapshot | (future) |

## Correction Prompt Strategy

Three thinking frameworks injected when interception fires:

1. **FIRST_PRINCIPLES** — strip assumptions, work backward from goal,
   atomic root-cause breakdown
2. **CAUSAL_TRACE** — git log/diff trace from earliest failure commit,
   revert to pre-failure state
3. **ADVERSARIAL** — enumerate failure modes, find counterexamples,
   propose non-obvious alternatives

## Safe Restore Protocol

On interception, agent must NOT use `git stash pop`. Instead:

```
git stash push -m watchdog-$(date +%Y%m%d%H%M%S)  # save current state
git log --oneline -5  # identify last stable commit
git reset --hard <stable-hash>  # reset to clean baseline
```

## State Files

| File | Location | Lifetime |
|------|----------|----------|
| Operation records | `~/.claude/reasoning-watchdog/<session_id>.jsonl` | Until SessionEnd |
| Intervention flag | `~/.claude/reasoning-watchdog/<session_id>.flag` | Until PreToolUse reads it |
| Orphaned files | `~/.claude/reasoning-watchdog/*.jsonl,*.flag` | 24h then cleaned |

## Steps

### Step 1 — Check status

```bash
cd ~/.claude/reasoning-watchdog && grep -c "reasoning-watchdog" ~/.claude/settings.json
# > 0 means installed
```

### Step 2 — Install or diagnose

- **Not installed** → offer `npm run install`
- **Installed but not working** → check if Claude Code was restarted
- **False triggers** → tune thresholds in `src/postToolHook.ts`

### Step 3 — Tune thresholds

Edit `src/postToolHook.ts`:

```typescript
const REPEAT_THRESHOLD = 3;        // N consecutive edits
const TOKEN_BURN_THRESHOLD = 5000; // tokens per minute
```

No rebuild needed — `tsx` runs TypeScript directly.

## Anti-patterns

- MUST NOT install while other hook scripts are active — may conflict
- MUST NOT modify `settings.json` hooks section manually while watchdog
  is installed — use `npm run uninstall` first
- MUST NOT use `git stash pop` in correction flows — use the
  SAFE_RESTORE protocol instead
- MUST NOT lower thresholds blindly to reduce false negatives —
  investigate root cause of frequent triggers first
