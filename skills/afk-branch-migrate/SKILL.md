---
name: afk-branch-migrate
description: >-
  Cross-branch code migration skill — cherry-pick code from one branch to
  another with intelligent analysis when branches have large differences.
  Analyzes commit content, identifies core logic vs incidental changes,
  presents conflict risk levels, and supports step-by-step confirmation
  with multi-step rollback. Pure Git operations only (no external API).
disable-model-invocation: false
---

# Branch Migrate

**Goal:** Extract code from a source commit and apply it to the target
branch with full awareness of conflicts, dependencies, and risk.
**Mode:** HITL — every step requires human confirmation before proceeding.
**Contract:** source commit + target branch → applied change with resolved
conflicts (or explicit conflict map if manual resolution needed).

## Core Loop

```
Step 1: Identify   → Locate the source commit (hash / search / range)
Step 2: Analyze    → Parse commit, identify core files and dependencies
Step 3: Assess     → Evaluate conflict risk against target branch
Step 4: Confirm    → User confirms which files/changes to migrate
Step 5: Apply      → Execute migration (cherry-pick or patch)
Step 6: Resolve    → Handle conflicts with risk-level guidance
Step 7: Verify     → Confirm migrated code is functional
Step 8: Done / Rollback → Success or rollback to checkpoint
```

## Steps

### Step 1 — Identify Source Commit

Support three input modes:

**A. Direct hash:**
```
afk branch-migrate --commit <hash>
```

**B. Branch + search:**
```
afk branch-migrate --branch <source-branch> --search "<description>"
```
Lists commits matching the description on the given branch.

**C. Commit range:**
```
afk branch-migrate --branch <source-branch> --from <hash1> --to <hash2>
```
Captures all commits in the range.

Show commit metadata:
- Hash, author, date, message
- List of changed files with +/- line counts
- Whether the commit is already on target branch

### Step 2 — Analyze

For the identified commit(s):

1. **Parse diff** — extract file-by-file changes
2. **Classify files:**
   - **Core logic** — files directly implementing the feature/fix
   - **Test files** — `*.test.ts`, `*.spec.ts`, `__tests__/`
   - **Config files** — `package.json`, `tsconfig.json`, etc.
   - **Incidental** — comments, formatting, documentation
3. **Identify dependencies:**
   - Imports used by core files
   - API contracts / interfaces
   - Environment variables or config keys

Present the analysis as a structured summary. Ask user which files to
include in the migration.

### Step 3 — Assess Conflict Risk

Compare each target file against the target branch:

| Risk Level | Meaning |
|------------|---------|
| **Low** | File unchanged or compatible on target |
| **Medium** | Minor conflicts, likely auto-mergeable |
| **High** | Significant divergence, manual resolution needed |
| **Critical** | File renamed/deleted/replaced on target |

For each file, show:
- Current status on target branch
- What would change
- Specific lines with potential conflicts (if detectable)

### Step 4 — Confirm

Present the migration plan:

```
Migration Plan:
├── Files to migrate: [file list]
├── Files to skip: [file list]
├── Estimated conflicts: N (M low, K medium, J high)
└── Rollback checkpoint: will be created before apply
```

User can:
- Accept as-is
- Modify the file selection
- Cancel the operation

### Step 5 — Apply

Create a rollback checkpoint:
```bash
git branch "backup/migrate-$(date +%Y%m%d-%H%M%S)"
```

Execute the migration:
- If few conflicts → `git cherry-pick <hash>`
- If many conflicts → `git show <hash> -- patch | git apply --3way`

### Step 6 — Resolve Conflicts

For each conflicting file:

1. Show the conflict markers in context
2. Display the risk level and what each side contains
3. Offer options:
   - **Keep target** — discard the source change for this file
   - **Keep source** — overwrite with source version
   - **Keep both** — merge changes manually (opens editor)
   - **Skip file** — defer resolution, handle later

High/Critical conflicts always require explicit user choice.
Low/Medium conflicts can optionally be auto-resolved with user consent.

### Step 7 — Verify

After applying:

1. Check the migrated code compiles / passes lint
2. If a test suite exists, run relevant tests
3. Report status:
   - Success: "Migrated N files, M conflicts resolved"
   - Partial: "Migrated N files, K conflicts remain unresolved"
   - Failed: "Migration failed, rolled back to checkpoint"

### Step 8 — Done / Rollback

**Done:** All files migrated successfully. Show summary.

**Rollback:** If user requests or if critical errors occur:
```bash
git checkout <checkpoint-branch>
```
Present available checkpoints and let user choose.

## Git Commands Used

This skill uses native git commands only:

| Step | Git Command | Purpose |
|------|-------------|---------|
| Identify | `git log <branch> --grep="<search>"` | Search commits by message |
| Identify | `git log <branch> --oneline <hash1>..<hash2>` | List commits in range |
| Analyze | `git show <hash> --stat` | Show commit changes summary |
| Analyze | `git show <hash> --no-stat` | Show full diff |
| Backup | `git branch backup/migrate-<timestamp>` | Create rollback checkpoint |
| Apply | `git cherry-pick <hash>` | Apply single commit |
| Apply | `git show <hash> -- patch \| git apply --3way` | Apply with 3-way merge |
| Resolve | `git diff --check` | Detect conflict markers |
| Verify | `git diff --cached` | Show staged changes |

State file: `.branch-migrate/state.json` (optional, for multi-step tracking)

## Anti-patterns

- MUST NOT auto-resolve High/Critical conflicts without explicit confirmation.
- MUST NOT call external APIs — all operations are local Git.
- MUST NOT proceed without a rollback checkpoint before applying changes.
- MUST NOT skip the confirmation step even if no conflicts exist.
- MUST NOT use `git push --force` or `git reset --hard` during migration.
