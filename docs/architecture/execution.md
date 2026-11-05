# AFK Execution Architecture

This document describes the **current implementation**, not an aspirational multi-agent execution blueprint. For the system boundary and sources of truth, see [Architecture Overview](overview.md); for the complete execution and evidence path, see [Full Workflow & E2E Architecture](full-workflow-e2e-architecture.md).

## System boundary

AFK executes provider-backed work items that already exist and have been decomposed upstream. It does not act as a global planner or split work into tasks. The external issue tracker remains authoritative for backlog state; local manifests, journals, run events, and evidence support execution and audit.

## Workspace packages

| Package / application | Responsibility |
|---|---|
| `@afk/core` (`packages/core`) | Pure domain models, events, reducers, policies, and ports |
| `@afk/application` (`packages/application`) | Shared use cases, inventory, and execution queries |
| `@afk/runtime` (`packages/runtime`) | Provider integrations, backlog operations, workflow execution, agent/sandbox adapters, Git, tmux, and persistence |
| `@afk/workflow-graph` (`packages/workflow-graph`) | Pure workflow graph representation, projection, layout, routing, and validation |
| CLI/TUI (`apps/cli`) | User-facing command surface and terminal UI |
| Desktop (`apps/desktop`) | Electron main/preload and React renderer; uses validated IPC and a detached Runtime worker for managed execution |

Applications consume shared packages through declared exports. Shared packages must not depend on applications. Desktop renderer code must not access Node Runtime directly; Node operations stay behind the main process. Package and import-boundary checks enforce these constraints.

## Execution entry points

- `afk`: open the interactive TUI.
- `afk run`: resolve a work item and delegate to the complete managed implementation → independent QA → publication lifecycle. Existing runtime, timeout, budget, extension, and explicit execution-mode options apply to the managed attempt; `--target-branch` names its working branch, not the MR destination.
- `afk execute --work-item-id <id>`: execute the managed lifecycle, including eligibility and manifest checks, implementation, independent QA, change-request handling, and the human-controlled merge gate.
- `afk loop start`: repeatedly attempt one manifest-bound work item by delegating to the same managed execution path. It is not a global multi-item scheduler.
- `afk qa`: retry an item in `verification`, using its managed manifest when present; `--execution-manifest <path>` selects an explicit manifest.
- `afk backlog baseline --id <prd>`: report the branch a PRD accumulates its slices on and the slices that inherit it; `--branch <name>` records the branch in the PRD's body.
- `afk schedule --parent <canonical-id>`: dispatch executable descendants across projects, serialize overlapping repository sets, and respect dependencies and human merge gates. `--max-concurrent`, `--load-limit`, and `--poll-interval` control dispatch; `--watch` waits for external state changes, `--dry-run` previews waves without claiming or launching work, and `--json` returns the final report. Each preview wave assumes prior waves have been merged and reconciled. SIGINT/SIGTERM stop dispatch and drain active attempts.
- `afk doctor [--workspace-root <path>] [--json]`: inspect bare caches, dependency pools, managed workspaces, live repository leases, and conservative reclaimable-byte estimates. This is read-only; `afk observe doctor` continues to describe the event store.
- `afk observe`: inspect executions and their audit/evidence projections.

The command registry in `apps/cli/src/command-registry.ts` is the source of truth for the complete CLI surface. Do not infer supported commands from old examples or plans.

## Data and workspace boundaries

- AFK configuration and system data live under `~/.afk/`.
- Execution workspaces live under `~/.loop-workspace/`.
- Per-workspace manifests, launch receipts, sessions, diagnostic runs, and execution journals are stored under the hashed workspace area in `~/.afk/workspaces/`.
- Repository checkouts live under the canonical execution workspace; the caller's current directory does not redefine the canonical execution root.
- New manifest-bound repository checkouts are linked worktrees backed by one cached bare repository per remote under `~/.loop-workspace/repos/<host>/<project>/bare.git`. Implementation and QA use the same store without changing manifest checkout paths. Existing independent clones remain supported.
- Bare repository creation, fetches, branch preparation, publication, and worktree removal in the preparer reuse the filesystem operation gate to serialize shared Git metadata operations per repository. Active worktrees retain independent working directories and indexes; Git refuses to check out the same writable branch twice.
- Successful implementation and borrowed QA workspaces release store-owned worktrees, including worktrees reused after a failed attempt. Failed attempts retain source and diagnostic evidence. A dirty store-owned retry saves tracked and untracked edits in a named `afk-recovery-*` Git stash, prepares the working branch, then reapplies the saved changes; the stash remains available if recovery conflicts. Independent clones still reject dirty preparation. Bare repositories, local branches, and recovery stashes survive worktree removal.
- Node dependencies are cached under `~/.loop-workspace/deps/<hash>/layout/`. Keys cover lockfiles, all workspace package manifests, package-manager configuration and patches, platform, architecture, and Node ABI. Installed dependencies are captured after a managed phase; matching phases attach them without installing. Real `node_modules` directories contain per-entry links, workspace package links point into the current checkout, and pnpm mutable state remains local. External or unsupported nested source links keep the original install rather than creating a broken cache. Maven and Go continue using their native global caches.
- Pools retain pins while checkouts reference them. Releasing a managed checkout drops its references; unpinned entries are evicted by least recent use above the default 8 GiB budget. Bare caches are retained. Existing independent clones remain supported without automatic migration; global package-manager store pruning is an explicit operator action after pool acceptance.
- Agent completion signals and QA artifact manifests are execution-local protocol files, not general configuration or lifecycle-state stores.

These paths describe distinct storage responsibilities. Consult the current implementation and [Full Workflow & E2E Architecture](full-workflow-e2e-architecture.md) for detailed resolution behavior; do not infer exact runtime paths from this summary.

## Managed lifecycle

The managed execution path validates the work item and its execution manifest, runs implementation, records branch and run evidence, performs independent QA, and prepares or verifies the provider-backed change request. A successful run does not merge code. The final merge is human-controlled; the work item reaches its terminal completed state only after merge and reconciliation.

The provider backlog, runtime state, run-event audit trail, and evidence are separate projections with different authority:

- Provider state is authoritative for backlog and change-request status.
- Runtime state records the execution attempt and its lifecycle.
- Append-only run events support audit and replay.
- Evidence references and classifications support QA, diagnostics, and redaction policy.

## Failure and recovery

### Failure diagnosis

A failed run carries a **structured failure diagnosis**, not a free-text reason. The diagnosis separates four things that used to be one string:

- `code` — the stable, machine-readable failure code (`agent_idle_timeout`, `upstream_model_error`, `acceptance_criteria_failed`, `qa_environment_missing`, `workflow_setup`, …). The same code always names the same kind of failure.
- `class` — what the failure is *about*: `work` (a verdict on the work), `agent` (a fact about the agent run), `upstream` (a fact about an external dependency such as the model service), `environment` (a fact about the machine), `infrastructure` (AFK's own plumbing). A reader must be able to tell "our code is wrong" from "our agent went quiet" from "the model service is overloaded" without reading prose.
- `message` — one human-readable root cause. It is never the provider's captured output.
- `evidence` — the facts behind it: probes with their command, expectation and observation; commands with their exit code; the truncated tail of the agent's output; the timeout budget, the last known activity and the basis on which a timeout was read as a timeout.

**The first failure wins.** A failure is recorded once, in a chain. A later failure never replaces the root cause: it is appended, and points back at the failure before it. `run.finished`, the blocked backlog item and the runtime record all carry the root cause, so the reason a run failed survives every piece of secondary information that arrives after it.

The agent's own report is the cause when there is one. The provider's captured stdout/stderr is evidence: it is kept as a truncated tail (4 KiB, last 40 lines) and its error lines are lifted into the cause, so a pre-commit hook's rejection is not replaced by the tail of a `pnpm` log.

Timeouts are first-class failures. An idle timeout, a completion timeout and a hard timeout each have their own code, and carry the budget that ran out, the last known activity and the basis of the judgement.

Whether repeating an attempt is meaningful is read from the diagnosis, not re-derived from a flattened string. The agent error-code vocabulary stays as it was: `AGENT_TURN_FAILED`, `AGENT_GONE` and `AGENT_IDLE` are facts about the agent run rather than verdicts on the work, and a timeout is a fact about the work.

An environment assertion is an **environment declaration**, never a test conclusion. When a check command cannot run on this machine, the blocker states which command was probed, what was expected and what was actually observed, and it is classified as an environment declaration so a reader can tell it apart from an acceptance criterion that failed.

The audit stream carries the diagnosis: `failure.classified` events carry the code, the evidence and a snapshot of the preceding failure, and `run.finished` carries the root cause in `reason` plus its code in `reasonCode`. The CLI reads the root cause back out of the stream: `afk log <runId>` shows `Cause: …` on an event that has no reason of its own, and `afk observe executions --json` lists the root cause of every failed execution.

### Execution refs and configuration

The item's `## Base Version` section declares an immutable execution plan:

```markdown
## Base Version

- Base Ref: release
- Target Ref: production
- Source Ref: migration-source
```

`Target Ref` defaults to `Base Ref`; `Source Ref` is optional and is fetched as a migration source, never substituted for the baseline. The manifest persists these as `baseBranch`, `targetBranch`, and `sourceBranch` per repository. QA verifies against the base and publishes to the target. Disagreement between the body and manifest is rejected before agent execution. Working-branch selection and `baseBacklogId` relationships remain separate from the publication target. Unsafe or conflicting declarations fail closed.

For undeclared refs, repository-local `.afk/project.yml` values override the matching `repositories.<projectKey>` entry in `~/.afk/config.yml`, followed by the provider repository's default branch and global `defaultBaseRef`. Legacy `trackerTargetBranch` / `targetBranch` settings and environment aliases remain global defaults. Each repository receives a new plan without mutating cached global configuration. A new run's explicit `--base-branch` can replace an undeclared default; it must agree with a declared plan or existing manifest.

```yaml
defaultBaseRef: main
repositories:
  group/api:
    baseRef: release
    targetRef: production
    sourceRef: migration-source
  group/web:
    baseRef: staging
```

### PRD baseline branches

A PRD accumulates its slices on a branch of its own. The repository's integration line is where that branch was cut from; it is not where the slices land. Every slice is written on the PRD's baseline branch and merges into it, and the baseline branch merges into the integration line once the whole PRD is done. A repository can therefore hold several PRDs at once, each with its own accumulation branch.

The branch is named after the PRD's issue number, so the same PRD uses the same branch name in every repository it touches:

```text
prd/<issue number>
```

A PRD that needs a different name declares it in its own body:

```markdown
## Baseline Branch

- Baseline Ref: prd/27
```

A slice inherits the PRD's baseline branch only when it declares no execution refs of its own. An explicit `## Base Version` declaration always wins: it is a statement about that one piece of work. The inherited branch is both where the slice starts and where it merges into — base and target are the same branch — while the functional `Source Ref` travels with the work and says nothing about the baseline.

The inheritance crosses repositories. A slice of a PRD lives in another repository than the PRD itself, and the branch name is the same in both, so the PRD's issue number is the only thing the inheritance needs to carry.

A baseline branch that does not exist yet is created from the remote's default branch when the repository is prepared; that is where the PRD's work started. A base branch somebody declared by hand is expected to exist, and a missing one is an error rather than a new branch. A PRD parent that cannot be read is an error where the answer decides where the work runs: silently using the integration line would put the slice exactly where the baseline model says it must not go. A question that only reports what was already published — which branch a change request targeted — ignores an unreadable parent instead, because a transient read must not block a human over a change that already exists.

`afk backlog baseline --id <prd>` reports the branch a PRD accumulates on and the slices that inherit it; `--branch <name>` records the branch in the PRD's body. `afk schedule` names the baseline branch in its report.

### Repository arbitration and dispatch

Managed execution holds leases for every manifest repository across implementation and QA. Standalone preparation acquires the same leases; nested phases borrow the enclosing lease. Acquisition sorts and deduplicates repository keys, rolls back partial acquisition, and rejects contention before claiming a managed work item. Heartbeats and generation IDs reuse `FilesystemClaimLock`; expired generations cannot renew or release successors. Recovery requires an expired lease and a demonstrably dead local owner; unknown or remote owners remain protected.

Interruption moves the item to `blocked + hitl` and invalidates its claim. Failed heartbeats or observed interruption kill owned agent executions and prevent publication. Terminal cleanup closes executions before releasing workspace resources. Failed QA retains its verification worktree. Managed local Claude tmux sessions register their repository claim generations before launch and carry the same ownership token in tmux. Dead-owner recovery verifies that token before stopping an orphan session; a reused session name, unknown ownership, or a non-tmux transport requires explicit operator recovery. No process is killed solely because its name resembles an AFK agent.

Generation checks protect AFK-controlled lifecycle operations. Agent writes remain direct filesystem operations; safe takeover depends on verified owner death and termination of registered resources. Unknown external writers require operator recovery.

The scheduler reads the complete credential-scoped inventory, rejects dependency cycles, and reuses provider runnability rules. Default capacity is `min(repositoryCount, max(2, floor(availableCores / 3)))`, with a minimum of one. Overlapping multi-repository manifests serialize; disjoint repositories can run concurrently. A one-minute load above the configured limit pauses new launches. Dependencies unblock at `done`; `merge_ready` awaits human merge and reconciliation. Rework attempts are bounded by `maxQaReworkAttempts`. Scheduling neither adopts unmanaged issues nor changes dependency labels.

### Recovery policy

Execution must fail closed when required identity, manifest, claim, or verification evidence is missing or invalid. Recovery and reconciliation use the existing work-item identity and recorded state; reconciliation is not a shortcut for creating a new execution manifest. If the agent stops responding or verification cannot run, the system must preserve evidence and surface a recoverable state rather than treating the task as complete.

The verification branch is the branch an earlier attempt published its change request from. When it is still there, the verification reuses that change request and refreshes its evidence instead of refusing to create a second branch with the same name — the merge into the baseline rewrites the branch anyway. The implementation branch is deliberately different: a branch that already exists may hold work that was never pushed, so a worktree for it is refused rather than reused. A preparation that fails gives its sharing guard back, so the attempt that follows reaches the real failure instead of a double prepare.

## Related documents

- [Full Workflow & E2E Architecture](full-workflow-e2e-architecture.md)
- [Observability and Evidence](observability.md)
- [Architecture decision records](../adr/README.md)
