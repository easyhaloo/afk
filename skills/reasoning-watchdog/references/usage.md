# Reasoning Watchdog — Usage Reference

## Quick Start

```bash
# Install
cd ~/.claude/reasoning-watchdog && npm install && npm run install

# Verify installed
grep -c "reasoning-watchdog" ~/.claude/settings.json

# Uninstall
cd ~/.claude/reasoning-watchdog && npm run uninstall
```

## Tuning Thresholds

Edit `src/postToolHook.ts`:

```typescript
// Repeat operations threshold
const REPEAT_THRESHOLD = 3;  // N consecutive edits

// Token burn threshold (tokens per minute)
const TOKEN_BURN_THRESHOLD = 5000;
```

After editing, no rebuild needed — `tsx` runs TypeScript directly.

## Testing the Watchdog

To confirm interception fires correctly:

```bash
# Create a test file with intentional issues
echo "const x: number = 'string';" > /tmp/test.ts

# In Claude Code, run:
# 1. Edit /tmp/test.ts multiple times with wrong types (should trigger repeat_ops)
# 2. Run a long task without making progress (should trigger token_burn)

# Check state files
cat ~/.claude/reasoning-watchdog/*.jsonl
cat ~/.claude/reasoning-watchdog/*.flag
```

## What Interception Looks Like

When triggered, the next tool call is blocked and Claude sees:

```
MULTI_SIGNAL_ANOMALY: Repeat ops + regression + token burn all triggered.
High risk state.

SAFE_RESTORE: git stash push -m watchdog-... && git log --oneline -5
&& git reset --hard <stable-hash>. Start fresh.

FIRST_PRINCIPLES:
1. Assumption audit: which inputs are verified, which are inferred?
...

CAUSAL_TRACE:
1. git log --oneline -10: identify session commits
...

ADVERSARIAL:
1. Assume last change is wrong: list failure modes
...
```

## Uninstall Cleanly

```bash
cd ~/.claude/reasoning-watchdog
npm run uninstall    # removes hooks from settings.json
npm run cleanup      # removes orphaned state files
```

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Hook fires on every tool call | `matcher: ""` matches all tools | Set specific matcher or confirm this is desired |
| No flag file created | PostToolUse hook not running | Check `npm run install` succeeded |
| Interception never fires | Thresholds too high | Lower in `postToolHook.ts` |
| Claude ignores correction prompt | PreToolUse hook not blocking | Check exit code is 2 in hook output |
