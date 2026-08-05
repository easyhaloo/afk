---
name: afk-to-issues
disable-model-invocation: true
description: >-
  Decompose approved requirements into a provider-neutral backlog manifest
  with machine-checkable acceptance criteria, dependencies, parent links,
  execution modes, and business tags. This skill drafts and validates the
  handoff; an external backlog system creates the records.
disallowed-tools: >-
  Bash(git push -f) Bash(git reset --hard*)
  Bash(git branch -D*)
---

# Requirements -> Backlog Manifest

**Goal:** Produce independently executable backlog items with verifiable
completion conditions. The output is a provider-neutral manifest for the
external backlog/decomposition system. AFK consumes the resulting backlog;
it does not create, link, or split provider records.
**Mode:** HITL-gated — draft first, obtain explicit approval, then emit the
approved manifest.

## Mode decision

| Input | Use |
|---|---|
| Approved `PRD.md` with `User Stories` and Observable Behaviors | PRD Mode |
| Any aligned requirement context without a PRD | Direct Mode |

Choose `executionMode` per item: `afk` for deterministic, automatable work;
`hitl` when a human decision, manual check, or non-automatable action is
required. This is a backlog field, not a provider label. Use business tags
only (for example `frontend`, `security`, or `needs-isolation`); never encode
state or execution mode in tag names.

## Verification inference

For each Observable Behavior (PRD) or requirement clause (Direct), inspect the
codebase to infer:

1. What proves the behavior — test runner, HTTP endpoint, log, file, or manual check.
2. The `evidence_type`: `test` | `curl` | `log` | `manual` | `none`.
3. A concrete `check_command` that exits 0 on PASS and does not mutate state.

If no signal is available, use `manual` and mark the item as needing an
automated check. Do not guess an evidence type.

## Slice strategy

1. Count distinct domains, layers, and ownership boundaries.
2. Select **Vertical** (model + API/logic + test) for one team and an
   end-to-end outcome; select **Horizontal** (one item per owned layer) when
   ownership is split. If unclear, ask the user.
3. Explain the selected strategy in the draft.

Split an item when acceptance criteria exceed roughly five lines, it spans
more than three modules, or it has a separate owner. Fold items with no
user-observable behavior into a neighboring item or mark them as tech debt.
Trace the dependency graph and reject cycles.

## Backlog item contract

Emit one manifest entry per item with these provider-neutral fields:

```yaml
- title: <short imperative title>
  description: <context and intended outcome>
  parentId: <provider backlog id or null>
  dependsOn: [<provider backlog ids>]
  executionMode: afk | hitl
  tags: [<business tags>]
  acceptanceCriteria:
    - text: <observable condition>
      evidenceType: test | curl | log | manual | none
      checkCommand: <command exiting 0 on pass>
  outOfScope: [<explicit non-goals>]
```

`parentId` and `dependsOn` are references supplied by the external provider;
use stable temporary references in a draft and have the provider resolve them
to IDs. Parents are organizational and are not runnable. Every dependency
must be complete before an `afk` item can be claimed. The provider assigns
the canonical ID and initial state; do not invent state labels in this
manifest.

## Steps

### 1. Select mode and read inputs

Determine PRD or Direct Mode, read the input, and inspect relevant code for
verification signals. Record unresolved questions rather than inventing
requirements.

### 2. Slice and compose drafts

Apply the slice strategy, dependency-cycle check, and isolation analysis.
For middleware, schema, or environment changes, add the business tag
`needs-isolation` and explain why. Compose every field in the item contract;
use `[]` for empty dependencies or out-of-scope lists.

### 3. Self-quality gate

Run every `checkCommand` in a sandbox. Fix non-zero results, invalid evidence
types, mutating commands, missing dependencies, or ambiguous ownership before
requesting approval.

### 4. HITL approval

Present all proposed items, parent/dependency edges, execution modes, business
tags, and isolation decisions. Wait for explicit approval. On revision,
incorporate the requested changes and repeat the gate.

### 5. Emit handoff

After approval, write the provider-neutral manifest and PRD reference to the
requested artifact location. Hand the artifact to the external backlog
provider/importer. Do not invoke an AFK command, create a branch, start an
agent, update provider metadata, or run QA.

## References

Read `references/issue-template.md` for the acceptance-criteria field
conventions when composing item bodies. Its historical filename does not
change this skill's provider-neutral output contract.

## Caveats

- Never create provider records before the approval gate.
- Never use provider-specific IDs, issue/MR terminology, state labels, or
  internal metadata names in the manifest.
- Every acceptance criterion must use the three-field evidence contract.
- `executionMode: afk` is appropriate only for work that can be fully
  automated; use `hitl` when a person must decide or act.
- Keep dependency references acyclic and explain any unresolved external
  reference for the importer.
