---
description: Git add, commit and push changes
argument-hint: [message]
allowed-tools: Bash(git:*)
---

# Commit Message Rules

## Format
```
<type>(<scope>): <description>
```

## Type
| Symbol | Meaning |
|--------|---------|
| `+` | feat（new feature）|
| `~` | fix（bug fix）|
| `*` | refactor（code refactor）|
| `M` | docs（documentation）|
| `-` | chore（deletion）|

## Scope
Determined by the directory of changed files:
- `src/commands/` → `commands`
- `src/lib/core/` → `core`
- `src/lib/plugins/` → `plugins`
- `skills/` → `skills`
- `README.md` / `docs/` → no scope

## Description
Generated based on file changes: verb + filename

## Argument Handling
| Situation | Handling |
|-----------|----------|
| No argument | Auto-generate from git diff |
| With argument | Polish to standard format: add `feat:` prefix if no `:` present |

## Execution
1. Analyze argument or generate message
2. Execute `git add -A`
3. Execute `git commit -m "<message>"`
4. Execute `git push`
