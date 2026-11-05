# ADR-0024 — PRD baseline branches

- **Status:** accepted
- **Date:** 2026-11-05
- **Decision Drivers:** slices must accumulate on one branch, a PRD spans several repositories, the repository's integration line is not a PRD's landing place, merges stay human-controlled

## Context

A PRD is decomposed into slices that land in different repositories. Every slice was written on, and merged into, its repository's integration line, so the pieces of one PRD were scattered across the repositories' main branches and could only be assembled by hand. The repository's integration line is where the work started — it is not a place where a PRD accumulates.

The relation that carries a slice to its PRD already exists: `parentId` names the organizational parent, and a PRD anchor is marked with the `prd` role. That edge was documented as organizational only, and the legacy `prd-<n>` base token mapped to a `prd/<n>` branch without saying what the branch was for.

Two things were missing. The rule that decides which branch a slice runs on was implemented in three places that did not agree — the manifest builder, the QA runner, and the standalone QA command. And a slice that declared no refs of its own had no way to learn the PRD's branch.

## Decision

1. A PRD accumulates its slices on a branch of its own, named `prd/<issue number>` after the PRD's issue, so the same branch name is used in every repository the PRD touches. A PRD declares another name in its own body under `## Baseline Branch` with `- Baseline Ref:`.
2. A slice inherits the PRD's baseline branch only when it declares no execution refs of its own. An explicit `## Base Version` declaration always wins: it is a statement about that one piece of work. The inherited branch is both the base and the target of the slice; the functional `Source Ref` travels with the work and is independent of the baseline.
3. Resolve the rule in one place. `resolvePrdExecutionPlan` fills only the gap between what the caller resolved and the repository's own defaults, and `resolveParentPrdBaseline` reads the parent and reports the branch. The manifest builder, the managed QA runner, the standalone QA command, and the expected-target resolution all use them, so a slice is verified and published against the branch it was written on.
4. A baseline branch that does not exist yet is cut from the remote's default branch when the repository is prepared and is pushed to the remote. A base branch declared by hand is expected to exist; a missing one is an error rather than a new branch. The manifest records which base is a PRD baseline so preparation knows the difference.
5. A PRD parent that cannot be read is an error where the answer decides where the work runs: quietly using the integration line would put the slice exactly where this model says it must not go, and declaring the base explicitly in the slice's body is the way out. A question that only reports what was already published — which branch a change request targeted — ignores an unreadable parent instead, because a transient read must not block a human over a change that already exists.
6. Report the model: `afk backlog baseline --id <prd>` names the branch a PRD accumulates on and lists the slices that inherit it, `--branch <name>` records the branch in the PRD's body, and `afk schedule` names the baseline branch in its report.

## Consequences

A PRD's slices now converge on one branch per repository, and that branch is merged into the integration line once the PRD is done rather than slice by slice. The branch name is derived from the PRD's issue number, so the inheritance crosses repositories without carrying a repository reference.

The rule is now one implementation instead of three, so the manifest, the QA baseline, and the publication target cannot drift apart. A slice that declares its own refs keeps them, which means an existing PRD whose slices declare `Base Ref: prd/<n>` behaves exactly as before.

Preparation can create a branch on demand, which means a mistaken branch name becomes a real remote branch. Only the PRD's own branch may be created this way; every other declared base must already exist.

The legacy `prd-<n>` base token still maps to `prd/<n>`. It now has a meaning behind it: the branch the PRD accumulates on.

## Validation

Focused tests cover the branch name, the body declaration, the inheritance from a parent, the refusal to guess when a parent cannot be read, the plan the inheritance builds, and the resolution order between a declared plan, the PRD baseline, and the repository defaults. The execution-base resolution is covered for a PRD parent, a non-PRD parent, a PRD that declares its own branch, and an unreadable parent. See [execution architecture](../architecture/execution.md) for the supported command surface.
