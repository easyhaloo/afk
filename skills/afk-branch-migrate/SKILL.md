---
name: afk-branch-migrate
disable-model-invocation: true
description: >-
  Cross-branch code migration — when you need to cherry-pick code from
  one branch to another with large differences. Analyzes commit content,
  classifies core vs incidental changes, assesses conflict risk, and
  guides step-by-step migration with rollback support. Pure Git only.
---

# Branch Migrate

**Goal:** Extract code from source commit and apply it to target branch
with full conflict awareness.
**Mode:** HITL — each step requires confirmation before proceeding.

## Workflow

### 1. Identify Source
- `--commit <hash>` — direct commit hash
- `--branch <branch> --search "<text>"` — search commits on branch
- `--branch <branch> --from <h1> --to <h2>` — commit range

Show: hash, author, date, message, changed files with line counts.

### 2. Analyze
Classify each changed file:
- **Core** — directly implements feature/fix
- **Test** — test files
- **Config** — package.json, tsconfig, etc.
- **Incidental** — comments, formatting, docs

Identify dependencies between files.

### 3. Assess Risk
Compare against target branch:

| Risk | Meaning |
|------|---------|
| Low | Unchanged or compatible |
| Medium | Minor conflicts, likely auto-mergeable |
| High | Significant divergence, manual work |
| Critical | File renamed/deleted/replaced |

Show per-file risk assessment with specific conflict lines.

### 4. Confirm Migration Plan
User selects which files to include/exclude.
Create rollback checkpoint before proceeding.

### 5. Apply
- Low/Medium conflicts: `git cherry-pick` or `git apply --3way`
- High/Critical: manual resolution with guidance

### 6. Verify
- **MANDATORY: Run build/compile immediately after applying changes**
- Do NOT skip or defer compilation — migration is NOT complete until code compiles
- Auto-detect build command by exploring codebase:
  - Check for `package.json` → use `pnpm build` or `npm run build`
  - Check for `Cargo.toml` → use `cargo build`
  - Check for `go.mod` → use `go build`
  - Check for `Makefile` → use `make`
  - Check for `CMakeLists.txt` → use `cmake && make`
  - If ambiguous, ask user which command to run
- Run relevant tests if available
- Report: success / partial / failed + rollback option

### 7. Rollback
List available checkpoints, allow restore to any point.

## Anti-patterns
- High/Critical conflicts MUST be manually resolved (no auto-merge)
- No external API calls — local Git only
- Always create rollback checkpoint before applying
- No `git push --force` or `git reset --hard`
