---
name: afk-to-issues
disable-model-invocation: true
description: >-
  Decompose requirements into tracker issues with machine-checkable
  acceptance criteria. Two entry points: an approved PRD with
  Observable Behaviors, or any requirement context in Direct Mode.
  Reads the codebase to choose verification means (test runner,
  HTTP endpoint, log file, manual check).
disallowed-tools: >-
  Bash(afk mr merge*)
  Bash(glab mr merge*) Bash(glab issue delete*) Bash(glab mr delete*)
  Bash(glab repo delete*) Bash(gh issue delete*) Bash(gh repo delete*)
  Bash(git push -f) Bash(git reset --hard*) Bash(git branch -D*)
---

# Requirements -> Issues

**Goal:** Independently pickable tracker issues with verifiable completion conditions.
**Mode:** HITL-gated — draft first, approve before creating.

## Input Paths (mode decision)

| Mode | Input | Trigger |
|------|-------|---------|
| **PRD Mode** | `PRD.md` `## User Stories` with Observable Behavior lists | An approved PRD exists |
| **Direct Mode** | Any requirement context (free text / notes / chat) | No PRD, or fast path |

## Execution Mode

`mode::afk` = autonomous execution. `mode::hitl` = human input during execution.
`evidence_type: manual` (verification) is orthogonal to mode. Default: `mode::afk`.

Mode is decided **once at the start** and propagates to:
- issue label `mode::afk` or `mode::hitl`
- issue base `base::prd-<iid>` (PRD) or `base::direct` (Direct)
- DAG source attribution

## Verification Inference

For each Observable Behavior (PRD Mode) or each requirement clause
(Direct Mode), read the codebase to infer:

1. **What proves the behavior** — locate:
   - Which test runner owns this layer (jest / vitest / mocha / pytest)
   - Which HTTP route handles this request
   - Which log line format this worker emits
   - Which file path / module name holds this state
2. **What `evidence_type` fits** — controlled vocabulary in
   `references/issue-template.md`: `test` | `curl` | `log` | `manual` | `none`
3. **What `check_command` exits 0 on PASS** — concrete shell snippet

Allowed tools: Read, Grep, Bash (read-only: ls, cat, grep, jq, find,
`afk issue list`, `afk mr list`). No mutating commands, no push, no delete.

If the codebase gives no signal for a behavior, default to `manual`
and flag it in the issue body as "needs automated check".

## Slice Strategy

1. **Analyze** the requirement: count distinct domains, layers, and team ownership lines
2. **Infer** the best-fit strategy:
   - One team, end-to-end ownership → **Vertical** (default)
   - Multiple teams with layer ownership → **Horizontal**
   - Unclear or both viable → ask user to choose
3. **Tell** the user which strategy was chosen and why — only ask if both are genuinely viable

| Strategy | Shape | Best when |
|----------|-------|-----------|
| **Vertical** | model+API+logic+test in one package | Single team, fast delivery |
| **Horizontal** | one issue per layer (API, DB, UI) | Layer-owned teams, staged rollout |

## Slicing Rules

- **Too big:** AC > ~5 lines, or touches > ~3 modules → split
- **Too small:** no user-observable behavior → fold into caller or mark tech-debt
- **Cycle check:** trace `blocked_by` graph; redraw boundaries if cyclic
- **Direct Mode:** ask user to narrow if requirement too large

## Isolate Analysis

For each slice, determine if it requires **isolated middleware** (MySQL, Redis,
ES, etc.) by checking for any of these signals in the requirement and inspected
codebase:

1. **Schema change** — the slice modifies a database table, index, or migration
   file
2. **Middleware config change** — the slice adds or modifies docker-compose
   service definitions, Redis cache keys, ES index mappings, or similar
   middleware configuration
3. **New middleware dependency** — the slice introduces a new service dependency
   that isn't available in the shared development environment

If any signal matches, mark the slice with `needs_isolate: true`.

| Signal | Example content |
|--------|----------------|
| Schema change | "add column", "migration", "CREATE TABLE", "ALTER TABLE", "new index" |
| Middleware config | "add Redis cache", "new ES index", "docker-compose" |
| New dependency | "integrate RabbitMQ", "add S3 bucket", "new message queue" |

## Issue Body Composition

Each draft must populate every field defined in
`references/issue-template.md`:

| Field | Source |
|-------|--------|
| `# <Title>` | PRD story title (verb + object) or Direct Mode user-stated title |
| `## Context` | One-paragraph problem statement lifted from PRD or paraphrased from Direct input |
| `## Acceptance Criteria` | One per Observable Behavior, in 3-field format from Verification Inference |
| `## Out of Scope` | Lifted from PRD story's "Out of Scope" section, or inferred from negative examples in Direct Mode |
| `## Dependencies` | DAG edges from `blocked_by` analysis; literal `none` if standalone |

## Steps

1. **Pick mode:** PRD exists → PRD Mode; else → Direct Mode. Lock in `mode::afk` / `mode::hitl`.
2. **Read inputs + read codebase:** for each Observable Behavior (PRD) or requirement clause (Direct), apply Verification Inference to produce `<text> -- <evidence_type> -- <check_command>`.
3. **Slice:** apply Slice Strategy + Slicing Rules. If strategy is ambiguous, ask user.
3b. **Cross-Project Dispatch (if applicable):** if the requirement spans multiple repos, decide per slice which repo it belongs to. Each slice's target repo drives the `--project` flag at execution time.
4. **Isolate Analysis:** for each slice, apply the Isolate Analysis to determine `needs_isolate: true/false`. Read the codebase to verify whether the slice actually touches middleware-related code (migration files, docker-compose, config files).
5. **Compose drafts:** for each slice, fill every Issue Body Composition field. Do not leave optional fields blank — write `none` for empty Dependencies, omit Out of Scope if user has none.
6. **Self-quality-gate:** run every `check_command` in a sandbox (no remote side effects). Any non-zero exit or vocabulary violation → fix the draft before HITL.
7. **HITL gate:** present all drafts + DAG + label scheme + `need::isolate` decisions + base label. Wait for explicit approval.
8. **Create:** on approval, run `afk issue create` with all labels at once (`--label stage::ready-for-issues --label <mode> --label <base>` + `--label need::isolate` if the slice requires isolation), then `afk issue link` for DAG edges.

   For cross-project slices, pass `--project <repo-path-or-owner/repo>` to point at the target repo. Use `<project>:<iid>` syntax when linking across repos (e.g. `afk issue link 100 group/repo-a:42 --project group/repo-b`). Loop auto-dispatches via `issue.projectId`; one-shot uses `afk issue run <iid> --project <repo>`.

## References

| File | Read when |
|------|-----------|
| `references/issue-template.md` | Always — defines the AC schema and body fields you emit |

## Anti-patterns

- AC without `-- <evidence_type> -- <check_command>` suffix
- `evidence_type` chosen without reading codebase (guessing is forbidden)
- `evidence_type` outside the controlled vocabulary
- `check_command` that doesn't exist, has no exit-code contract, or mutates state
- Skipping Step 6 self-quality-gate — drafts with unverified commands reach HITL
- Creating issues before Step 7 approval — even one issue
- `mode::afk` for cross-context or mid-flight product decisions
- Paste full requirement into issue — summarize + link source
- Use "no PRD" to skip this workflow entirely
- Leave `Requirement Source:` blank (Direct Mode) or `PRD:` placeholder (PRD Mode)
- `Shallow Module` beyond single-entity CRUD
- Forgetting to apply `need::isolate` on slices that require middleware isolation — the loop won't start isolated containers without it