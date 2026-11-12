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
- `afk execute --work-item-id <id>`: execute the managed lifecycle, including eligibility and manifest checks, implementation, independent QA, change-request handling, and the human-controlled merge gate. `--agent <name>`, `--sandbox <name>`, and `--execution-mode <batch|interactive>` select the attempt's providers and mode; a template may still select a provider for an individual step.
- `afk experience list --scope <platform:projectKey> [--status <candidate|verified|revoked>] [--limit <0..100>] [--json]`: inspect scoped experience. `recall --scope <scope> --query <text> [--json]` returns relevant verified, unexpired records.
- `afk experience export --scope <scope> [--limit <0..100>] [--output <new-file>]`, `import --scope <target> --file <file>`, and `copy <id> --scope <source> --target-scope <target>`: exchange bounded portable JSON (1 MiB / 100 lessons). Imported/copied advice is candidate-only and requires local independent verification. Export never grants verification authority. `metrics --scope <scope> [--json]` separates retrieval, explicit adoption and recurrence; `adopt <id> --scope <scope> --run-id <run> --work-item-id <canonical-id>` acknowledges use without claiming observed behavior.
- `afk experience record --scope <scope> --trigger <text> --root-cause <text> --action <text> --run-id <id> --work-item-id <id> --evidence <refs...>`: record a candidate. `verify <id> --scope <scope> --run-id <id> --action <text> --evidence <refs...> [--root <event-store>] [--root-cause <text>]` requires an intact same-project independent QA pass followed by successful completion or confirmed publication at the matching human merge gate. `revoke <id> --scope <scope>` withdraws advice from later retrieval.
- `afk loop start`: repeatedly attempt one manifest-bound work item by delegating to the same managed execution path. It is not a global multi-item scheduler. `--run-tag <tag>` files the run under `~/.afk/loop-runs/<tag>/`; without it the tag is derived from `--work-item-id`, or is `default`.
- `afk loop status [--run-tag <tag>] [--all]`: report one run from its pid file and status snapshot, or every run in the runs directory. `afk loop stop` signals the same run.
- `afk qa`: retry an item in `verification`, using its managed manifest when present; `--execution-manifest <path>` selects an explicit manifest.
- `afk host ls [--provider <name>] [--json]`: list hosts from the selected installed host provider. The default provider is `jumpserver`.
- `afk host exec <host> <command> [args...] [--provider <name>] [--timeout <duration>] [--json]`: execute a structured remote argv vector and preserve the remote exit code. Provider failures return exit code `1` with a stable diagnostic.
- `afk plugin install <source>`: install a trusted local directory or npm package specification in a staging directory, validate its `plugin.json` manifest/entry, record entry integrity, and enable it. An ordinary failed upgrade preserves the previous installation; npm lifecycle scripts are disabled. The package must include its built entry.
- `afk plugin configure <id> --file <path> [--builtin] [--action <name>]`: save a JSON settings object. Installed-plugin settings are checked against the manifest schema; `--builtin` validates and constructs a known configured provider. `--action` writes the plugin entry's top-level trigger action; omitting it preserves the existing action.
- `afk plugin auth login google --client <path>`: delegate browser OAuth and a loopback callback to `GoogleOAuthCredentialProvider` using a Google Desktop app client JSON file; no email input is required. SIGINT/SIGTERM abort authentication and close its callback server. After successful login, configure builtin `credential.google-oauth` with `{}` and add builtin `notification.gmail` with `{}` only if absent, preserving existing Gmail settings. The default recipient is the authenticated account; login sends no mail. See [Gmail OAuth setup](plugins.md#gmail-oauth).
- `afk plugin auth status google`: print only local Keychain record state (`connected`, optional `email` and `expiresAt`); no client file or token output. This does not verify the Google session or token validity.
- `afk plugin auth logout google`: revoke Google authorization, then remove the Keychain record only after successful revocation; failures retain the record for retry. No client file is required; retain plugin configuration and enablement. SIGINT/SIGTERM abort the operation. Only `google` is accepted by these authentication commands. Credentials use macOS/Linux Keychain; Windows is unsupported and tokens are not saved to files.
- `afk plugin enable <id>` / `afk plugin disable <id>`: change enablement for the next runtime construction; a running Worker is not hot-reloaded.
- `afk plugin remove <id>`: disable and remove an installed package while retaining its settings.
- `afk plugin import-issue <provider> <issue> --project <platform:projectKey> [--mode <hitl|afk>] [--json]`: import a Linear/Jira issue into the target repository's real managed backlog with stable source provenance and idempotency. Defaults to `hitl`; the returned canonical work item uses existing execution, QA and publication. `sync-issue <provider> <issue> <canonical-work-item> --states <json-file> [--json]` checks the binding and updates only the explicitly mapped external lifecycle state. Workflow actions `work-item.import` and `work-item.sync` expose the same behavior.
- `afk plugin invoke <capability> <provider> <operation> --input <path> [--json]`: dispatch explicitly allowed operations with validated JSON input and output. Output is JSON with or without `--json`; negative verification/policy/delivery results or a nonzero remote code set exit status `1`. Credential reads and merge operations are excluded. CLI verification input requires an explicit `target`. Repository lifecycle handles belong to one Runtime instance; `repository.provider/run` keeps prepare, checkout, the registered callback action, publication and cleanup in one invocation.
- `afk plugin listen --token-env <name> [--host <address>] [--port <number>] [--queue <path>]`: activate configured triggers and keep an authenticated HTTP host and Runtime alive until SIGINT/SIGTERM, then close/dispose them. Defaults to `127.0.0.1:8374` with a durable SQLite queue at `~/.afk/triggers/deliveries.sqlite`; the environment token requires at least 16 characters without CR/LF. Authenticated webhook receipts are persisted before HTTP 202, deduplicated and retried with bounded backoff; failed deliveries remain inspectable and replayable. Startup rejects error diagnostics; an unregistered action disposes its trigger. Ordinary runtime construction does not arm timers. See [Capability plugins](plugins.md).
- `afk plugin deliveries --token-env <name> [--url <listener>]` and `afk plugin replay <delivery-id> --token-env <name> [--url <listener>]`: inspect the running queue and replay one failed delivery through authenticated HTTP. HTTPS or loopback HTTP is required; redirects are refused. Delivery status does not expose payloads. Managed execution derives a stable ID from the delivery and canonical work item; interrupted executions retain their audit/journal for reconciliation instead of starting duplicate jobs.
- Delivery inspection accepts `--offset <number> --limit <1-100>` for older receipts. `afk plugin prune-deliveries --token-env <name> [--url <listener>]` explicitly removes successful receipts older than the deduplication window (seven days by default); pending/failed records remain. The queue refuses new receipts with HTTP 503 at its count/byte limit rather than evicting retained work.
- `afk plugin serve-container --repository <path> --workspace-root <path> --sandbox <provider> --agent <providers...> --token-env <name> [--host <address>] [--port <number>] [--allow-remote]`: explicitly host remote-container sandbox/agent operations through shared registries. All five unbracketed flags are required; workspace root must already exist and bounds execution worktrees, agents form an explicit allowlist, and the environment token must be at least 32 bytes. Defaults to `127.0.0.1:8375`; non-loopback binding/clients require `--allow-remote`. SIGINT/SIGTERM close the service and dispose the runtime. Backend assembly and trust boundaries are documented in [Capability plugins](plugins.md).
- `afk plugin list [--json]`: list loaded capability plugins, declared capabilities and registered provider names, rather than all packages present on disk.
- `afk plugin doctor [--plugin <id>] [--json]`: run plugin health and diagnostics checks, including load/configuration failures. An unhealthy provider or error diagnostic returns failure while optional plugin load errors leave core command handling available. See [Capability plugins](plugins.md) for API v1, the provider matrix and current composition/invocation adoption status.
- `afk backlog baseline --id <prd>`: report the branch a PRD accumulates its slices on and the slices that inherit it; `--branch <name>` records the branch in the PRD's body.
- `afk backlog rework revise --id <backlog> --record <r2> --summary "<fact>"`: correct an open rework record to the current fact; the record keeps its id and its evidence, only the statement is replaced, and the correction keeps its own trail in the record.
- `afk backlog revise --id <backlog> --project <platform:projectKey> (--description-file <path> | --description-stdin) [--reason "<why>"] [--dry-run]`: replace the body of a backlog item — the contract and the acceptance criteria it carries — and nothing else about it. The title, the state, the tags, the relationships and the role of the item stay exactly where they are: a revision of a contract is not a change of the work's position in the backlog. The body is written as it was given, so an AFK-managed section the revision would remove is reported rather than rebuilt silently. `--dry-run` reports the body that would be written and the sections that change, and writes nothing at all.
- `afk schedule --parent <canonical-id>`: dispatch executable descendants across projects, serialize overlapping repository sets, and respect dependencies and human merge gates. `--max-concurrent`, `--load-limit`, and `--poll-interval` control dispatch; the poll interval is the re-evaluation cadence, so the schedule is looked at again while executions are in flight and idle capacity is filled as soon as something becomes dispatchable. `--watch` keeps the schedule running until it is stopped, waiting for external state changes; `--dry-run` previews waves without claiming or launching work, and `--json` returns the final report. Every waiting item in the report names the constraint that keeps it waiting — an unready dependency, a full capacity, a held repository lease, an overloaded host, a human gate, or a spent attempt budget. Each preview wave assumes prior waves have been merged and reconciled. A failed inventory read does not end the schedule: it backs off and retries, and says that the scheduler is running but cannot see the work items. SIGINT/SIGTERM stop dispatch and drain active attempts.
- `afk doctor [--workspace-root <path>] [--cleanup <target>] [--json]`: inspect caches, dependency pools, managed workspaces and leases. Default inspection is read-only, including legacy manifests. Cleanup requires one exact reported work-item ID or absolute workspace/dependency path; it retains unknown, legacy, active, dirty, unpublished or verification work. Byte estimates and inventory totals describe the state before cleanup; `afk observe doctor` describes the event store.
- `afk observe`: inspect executions and their audit/evidence projections.

The command registry in `apps/cli/src/command-registry.ts` is the source of truth for the complete CLI surface. Do not infer supported commands from old examples or plans.

## Data and workspace boundaries

- AFK configuration and system data live under `~/.afk/`.
- Runtime state belongs in a directory under `~/.afk/`, never in a separately configured file path. A loop run is `~/.afk/loop-runs/<tag>/`, holding its pid file and status snapshot; the state root keeps only singleton configuration such as `config.yml` and `workflows/`. Per-file path overrides are not part of the CLI: the retired `AFK_LOOP_PID_FILE` and `AFK_LOOP_STATUS_FILE` are why loop state used to appear in the state root itself.
- Execution workspaces live under `~/.loop-workspace/`.
- Per-workspace manifests, launch receipts, sessions, diagnostic runs, and execution journals are stored under the hashed workspace area in `~/.afk/workspaces/`.
- Repository checkouts live under the canonical execution workspace; the caller's current directory does not redefine the canonical execution root.
- New manifest-bound repository checkouts are linked worktrees backed by one cached bare repository per remote under `~/.loop-workspace/repos/<host>/<project>/bare.git`. Implementation and QA use the same store without changing manifest checkout paths. Existing independent clones remain supported.
- Bare repository creation, fetches, branch preparation, publication, and worktree removal in the preparer reuse the filesystem operation gate to serialize shared Git metadata operations per repository. Active worktrees retain independent working directories and indexes; Git refuses to check out the same writable branch twice.
- Successful implementation and borrowed QA workspaces release store-owned worktrees, including worktrees reused after a failed attempt. Failed attempts retain source and diagnostic evidence. A dirty store-owned retry saves tracked and untracked edits in a named `afk-recovery-*` Git stash, prepares the working branch, then reapplies the saved changes; the stash remains available if recovery conflicts. Independent clones still reject dirty preparation. Bare repositories, local branches, and recovery stashes survive worktree removal.
- Node dependencies are cached under `~/.loop-workspace/deps/<hash>/layout/`. Keys cover lockfiles, all workspace package manifests, package-manager configuration and patches, platform, architecture, and Node ABI. Installed dependencies are captured after a managed phase; matching phases attach them without installing. Real `node_modules` directories contain per-entry links, workspace package links point into the current checkout, and pnpm mutable state remains local. External or unsupported nested source links keep the original install rather than creating a broken cache. Maven and Go continue using their native global caches.
- Pools retain pins while checkouts reference them. Releasing a managed checkout drops its references; unpinned entries are evicted by least recent use above the default 8 GiB budget. Bare caches are retained. Existing independent clones remain supported without automatic migration; global package-manager store pruning is an explicit operator action after pool acceptance.
- Agent completion signals and QA artifact manifests are execution-local protocol files, not general configuration or lifecycle-state stores.
- Finished-run state is retained for a fixed window rather than forever. A run that reaches a terminal state prunes `~/.afk/runtime/tasks/archive` records and `~/.afk/runtime/tasks/diagnostics` snapshots older than seven days, at most once an hour and never as part of the run's own success criteria. The corresponding window for terminal event streams under `~/.afk/events/` is implemented by the event store but not yet scheduled by a caller; a deployment that wants it must invoke `prune({ retentionMs, exclusiveAccess: true })`.

These paths describe distinct storage responsibilities. Consult the current implementation and [Full Workflow & E2E Architecture](full-workflow-e2e-architecture.md) for detailed resolution behavior; do not infer exact runtime paths from this summary.

### The hashed area is keyed by absolute path

`workspaceDataDirectory(path)` is `~/.afk/workspaces/<sha256(resolve(path))>`; the path *is* the primary key. Each work item therefore occupies **two** hashed directories, because two different strings are hashed:

| Key | Derived from | Holds |
| --- | --- | --- |
| workspace root | `executionWorkspacePath(workItemId)` | `execution-manifest.json`, `executions/<id>.jsonl`, execution locks, `budgets/`, `retro/` |
| checkout | `<workspace root>/repositories/<name>` | `sessions/`, `handoff/`, `runs/`, `worktrees.json`, `claude-status.json`, archify cache |

Renaming `~/.loop-workspace`, or changing the work-item directory layout, re-keys both halves and is **not** a rename: the old bytes stay where nothing looks for them any more. The failure is silent, which is what makes it dangerous: `existsSync(executionManifestPath(id))` turns false and the item is re-resolved as an unmanaged run, while `inspectWorkspaceDisk` skips manifests whose recomputed root no longer matches and reports zero reclaimable workspaces over unchanged disk usage; a lock taken under the old key no longer excludes a second execution; sessions and handoff documents fall back to their degraded path.

Only the first half is recoverable — a manifest records its `workItemId`, so the new key can be recomputed. The second half carries no id inside it, so it cannot be re-keyed without a separate pass over `sessions/*.json` or a declared loss. A layout change is therefore a migration with two mechanisms, not a `mv`. Prefer an explicit design (ADR) over an in-place edit.

## Managed lifecycle

The managed execution path validates the work item and its execution manifest, runs implementation, records branch and run evidence, performs independent QA, and prepares or verifies the provider-backed change request. A successful run does not merge code. The final merge is human-controlled; the work item reaches its terminal completed state only after merge and reconciliation.

### Execution readiness versus publication readiness

Two kinds of backlog edge gate different stages:

- `depends-on::` — the upstream item must be `done` before this item may **start**. The execution path refuses to claim an item whose execution dependency is unmet.
- `depends-on-contract::` — the upstream item owns a contract this item builds against. It never blocks execution: a slice may be implemented against the frozen request/response shape and a local mock. It blocks **publication**: once QA passes, the run refuses to publish the change request while any contract dependency is not `done`.

The split exists because a cross-repository dependency usually has a stable contract long before the upstream implementation lands. Without it, every downstream slice waits for an upstream merge it does not actually need, and the only workaround is deleting the dependency label — which loses the edge and invites merging unverified calls.

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

### The goal condition budget

A goal condition has a character budget, and the budget belongs to the **provider**, not to AFK. `AgentProvider` declares it (`promptLimits.goalConditionMaxChars`); Claude Code declares the 4,000 characters its TUI enforces. AFK asks the provider instead of guessing a number.

The limit applies to the **goal channel only** — the text that follows the `/goal` command. A prompt delivered as an ordinary message (batch mode strips `/goal`) has no goal-condition limit and is not measured against one. A provider that declares no limit is measured against the strictest limit AFK knows of: refusing a goal that might have been accepted costs one message, dispatching a goal that is refused costs the whole idle timeout.

**The content does not travel in the prompt.** The backlog description — the acceptance criteria list — is written into the worktree as `.afk/backlog-context.md`, and the goal keeps the template's task statement, the backlog title, and a pointer telling the agent to read that file first. The prompt length is therefore decoupled from the description length, and the criteria are still delivered verbatim. `.afk/` is AFK's own runtime-artifact directory: the file never enters a change request and never makes a worktree look dirty. Both the QA path and the implementation path do this.

The prompt is assembled from **labelled pieces** (task statement, title, context pointer, rework context, completion protocol), so a prompt that is too long can name the piece responsible.

**A problem found before dispatch is found before dispatch.** The final prompt is measured against the provider's declared limit before the agent is started. Over the limit, the run fails at once with the structured diagnosis above: `prompt_budget_exceeded`, the actual length, the limit, the piece that crossed it, and the suggested action — instead of dispatching a prompt that will be refused in silence and dying half an hour later on an idle timeout. See [ADR-0026](../adr/0026-goal-condition-budget-and-worktree-context.md).

### The rework cycle budget

A QA failure routes the item back for rework, and `maxQaReworkAttempts` bounds how many times AFK may try again **without a person deciding**. The budget belongs to a **rework cycle** — one round of fix-and-verify — and not to the item's whole life.

A cycle is opened by an operator intervention and by nothing else. `afk backlog retry` creates an operator rework record: the operator has answered the failure that ended the previous round and says that something changed, so the next round starts with a full budget. A QA failure or a merge conflict does not open a cycle — it is another try inside the round that is already running, and it spends that round's budget, so the automatic retries of one round share one budget.

Each rework record carries the cycle it belongs to and the attempt it spends inside it (`cycle`, `attempt`), and its handle is `r<cycle>-<attempt>`. The attempt of a new record is derived from the records of the running cycle only; the records of the earlier cycles stay in the issue as the audit trail without spending the budget of the rounds that follow them. A record written before cycles existed reads as cycle 1 and keeps its attempt, so an item that already spent its budget stays over budget until an operator opens the next cycle.

When the budget of a cycle is spent, the item is blocked and the reason says which round and how much of it was used: `QA rework attempt limit reached (cycle 2, 3/3 attempts used): …`. See [ADR-0028](../adr/0028-rework-attempt-budget-per-cycle.md).

### A rework record is correctable

A rework record states what was wrong when the round failed, and it is read back to the next agent as the context of that round. A statement can go stale: the dependency it waited for has since been produced, or the branch it complained about has since moved. AFK could create a record and supersede it with the next round, but it could not **correct** one — so a frozen statement was read as a present fact.

`afk backlog rework revise --id <backlog> --record <r2> --summary "<fact>" [--reason "<why>"]` corrects an open record. The correction is written **in place**: the record keeps its id, its cycle, its attempt and its comment, so the round the agent is told about does not change — and a correction does not spend an attempt of the running cycle's rework budget, which is what opening a new generation of the record would have done.

Only the statement is corrected. The evidence a record carries — the failed criteria and the required checks — is what the verification actually observed, and it is never rewritten and never dropped: a correction says "this is still true today", not "this was never true".

A correction is a **fact, not an instruction**. The record is read by an agent, so a revision that names a branch as the destination of a push (`publish to prd/27`, `把 prd/27 合进当前分支`), carries a git command, or carries a command that merges or re-runs work is refused before it reaches the provider. The correction keeps its own trail in the record — when it was written, who wrote it, what the statement was before — so a correction is never a silent overwrite. See [ADR-0035](../adr/0035-rework-records-are-revisable.md).

### The range a schedule depends on

A scheduler reads the whole platform, and it has to: a PRD's slices live in the repositories the work touches. The credentials reach far more projects than any one PRD does — on the machine that drives PRD #27, 46 GitLab projects are visible and the PRD's slices live in 7 of them.

Two ranges meet in the scheduler, and they used to be treated as one. The schedule *decides* about a PRD's subtree and the work that subtree waits for. The *read* covers every project the credentials reach. The completeness check was the platform-wide one — "not one diagnostic" — so a single unreadable repository out of forty-six made the whole platform "incomplete", and the scheduler backed off and dispatched nothing while looking perfectly alive.

The scope is now the range the decision depends on: the parent PRD, its children transitively, and everything those wait for transitively. It is derived from the relationships AFK itself writes, and it crosses repositories.

**An unreadable dependency still names its project.** A work item identity carries its project key, so a slice that waits for work in a repository AFK could not read still says which repository matters. That repository is inside the scope even though not one of its items was ever read. Without this rule the gap in the data would look like evidence that there is nothing there, and the slice would be dispatched on a view of the world that does not exist.

- **Outside the scope**: the project is named — in the log, in the status and in the final report — and the schedule continues. A failure is only a failure of the thing it is about.
- **Inside the scope**: the slices that depend on the unreadable project wait, with the reason `visibility_unknown`, and the rest of the tree is dispatched as usual. One broken repository does not paralyze the PRD; it paralyzes the slices that need it.
- **A project list failure** is always inside the scope: AFK could not enumerate the candidates, so it cannot prove that any project is outside it.
- **A failure that cannot be retried** (`retryable: false` — a repository that was deleted) is escalated rather than retried forever: the log says at error level that a person has to act, and the affected slices wait as `awaiting_human`. The scheduler does not write this to the provider; the escalation is a visible report. A dropped connection is transient, and is read as transient: a network blip is not handed to a person.

The parent PRD is the anchor of the scope. If the repository holding it cannot be read, the schedule knows nothing about that PRD, so the read failed *for this schedule*: it backs off and retries instead of dying. A project **list** that could not be read is the same answer — the parent is unknown, not absent. A parent that is missing while no project failed is a different answer — the PRD does not exist — and it is reported as an error.

The guarantee is kept: AFK does not schedule work whose state it cannot see. What changed is the range the completeness is measured against. See [ADR-0036](../adr/0036-schedule-scope.md).

### The publish boundary

An agent is given a repository with several branches in it, and it is told
which one to work on. That was never enough, because the same instruction
also named the branch the change request merges into, and an agent that
read "publish to `prd/27`" as "push to `prd/27`" advanced the PRD baseline
with its own commit. The change request then had nothing left to merge,
GitLab called it unmergeable, and AFK answered by sending the item back for
another round — which pushed the baseline again.

**The target branch belongs to AFK's change request.** The agent owns the
**working branch** and nothing else: it commits there and pushes there.
The **base branch**, the **target branch** and the **source branch** are
read, never pushed.

The rule is stated where every agent reads it — the completion protocol,
in both transports and for every phase — and again with the branch names
in the `Execution repositories:` segment, so the agent does not have to
infer which of the four names it may move. Both texts come from
`describePublishBoundary()` in
`packages/runtime/src/domain/branches/publish-boundary.ts`.

The rule is also enforced afterwards, because an instruction is not a
mechanism. `ChangeMergeState` carries a fourth value beside `mergeable`,
`conflict` and `unknown`:

- `mergeable` — the change request can land.
- `conflict` — the content disagrees. The target branch changed the same
  lines.
- `baseline_advanced` — the target branch already carries the change, so
  there is nothing left to merge. The baseline moved; the content did not
  conflict.
- `unknown` — the platform has not settled on a verdict, or it named a
  reason that is not a conflict.

GitLab reports both a real conflict and a change request with nothing left
to merge as `cannot_be_merged`; the diff separates them, because an empty
diff means the merge base of the two branches is the source head itself.
GitHub reports the same situation as `mergeable_state: behind`.

`decideMergeVerdict()` turns a verdict into an action, and the three
answers are deliberately different:

| verdict | action | why |
|---|---|---|
| `mergeable` | accept | hand it to a person to merge |
| `conflict` | rework | the content disagrees; another round can fix it |
| `baseline_advanced` | **escalate** | the work is already in the baseline; another round would move the baseline again |

An escalated item is blocked with `executionMode=hitl` and carries the
failure code `baseline_advanced`. It is never sent back for rework: the
rework would be answered by the same push that caused it. See
[ADR-0031](../adr/0031-publish-boundary.md).

### The provider and its runtime

AFK runs an agent with two facts: **which** agent runs, and **how** it
runs. The second one is the *runtime* — for Codex that is the model
provider, the profile, the transport and the endpoint.

They travelled in two independent channels, and a workflow step could
change the first without changing the second. A step that ran Codex while
the request ran Claude Code inherited Claude Code's runtime — which was no
runtime at all — so every Codex setting was silently dropped. Codex did
not object: it read its own host configuration and connected to the host's
default provider instead. The agent started, connected, and failed on its
first turn with a transport error from an endpoint nobody had chosen.

**A provider and the runtime that runs it are one decision.** The workflow
engine binds the runtime per step, at the point where the step's provider
is known, through `resolveRuntimeForProvider()` in
`packages/runtime/src/domain/agents/runtime-binding.ts`:

- a Codex runtime is reused only for Codex;
- a non-Codex provider resolves to no runtime, exactly as before;
- a Codex step whose request carried no Codex runtime gets one resolved
  from AFK's configuration, so the operator's `agents.codex.*` applies.

A runtime resolved inside the run is probed before the agent starts, so an
unreachable model fails with the probe's own diagnosis instead of a
transport error from the wrong endpoint. The probe costs a live model
round-trip, so it runs once per provider per run. See
[ADR-0032](../adr/0032-provider-and-runtime-are-one-decision.md).

The verification branch binds the same way. The QA reviewer resolves its
provider and its runtime together: a reviewer that names its own provider
resolves the runtime that belongs to it, and a runtime the caller already
probed is used as it is — the reviewer never probes the same runtime twice.

### Modals in the agent's TUI

AFK drives an interactive TUI it does not own, and that TUI opens modals of
its own. Codex asks whether it may trust a directory it has not seen
before — and AFK runs the verification step in a **worktree**, whose path
is never in Codex's trusted list, so the question appears on every fresh
worktree.

A modal takes the keyboard. The Enter presses that submit the goal are
swallowed by it, and the folder-trust question restarts Codex behind it, so
the goal comes back to the composer with no way to reach the agent. AFK
already notices that the composer still holds the goal and presses Enter
again; the budget for that is now a time window (30 seconds) instead of a
few presses, because it has to outlast the restart.

AFK names the modal it is answering and logs it, so the gap between "goal
sent" and "goal never arrived" is visible in the run log rather than only
in the pane scrollback. See
[ADR-0033](../adr/0033-agent-tui-modals.md).

A modal that is already up when AFK arrives is answered too. The modal
covers the composer, so the placeholder stays hidden and the composer
never looks ready; AFK would then wait out the whole timeout and type the
goal *into* the modal, where it is lost with it. AFK recognises the modal
in the pane, presses Enter to answer it, and waits for the composer to
come back.

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

The scheduler reads the complete credential-scoped inventory, rejects dependency cycles, and reuses provider runnability rules. Default capacity is `min(repositoryCount, max(2, floor(availableCores / 3)))`, with a minimum of one. Overlapping multi-repository manifests serialize; disjoint repositories can run concurrently. A one-minute load above the configured limit pauses new launches. Dependencies unblock at `done`; `merge_ready` awaits human merge and reconciliation. Rework attempts are bounded by `maxQaReworkAttempts` per rework cycle, so an operator retry gives the item a fresh budget. Scheduling neither adopts unmanaged issues nor changes dependency labels.

The dispatch loop wakes on two events: an execution finishing, and the poll interval elapsing. The timer is what keeps idle capacity usable — a schedule with capacity four and one slice in flight has to fill the other three slots as soon as their slices become dispatchable, not when the running slice ends, because an idle slot is wasted capacity and wasted capacity is a PRD that ships late. The timer is cancelled as soon as the loop has a reason to look again, so it never keeps the process alive. Without `--watch` the schedule is one-shot: it ends once the current wave has dispatched everything it can. With `--watch` it runs until it is stopped, because the help promises it keeps watching for merged dependencies and operator retries. The waiting report names the binding constraint for every item the scheduler did not dispatch, so an operator can tell a full capacity from an unready dependency instead of reading "waiting" for both.

A temporary failure is not a permanent failure. A failed inventory read does not end the scheduler: it counts the failure, waits a backoff that starts at the poll interval and doubles up to a five-minute ceiling, and tries again. The counter resets with the first read that succeeds. The failure is never silent — the run log carries the diagnostic, the failure count and the delay before the next attempt, and the command line says that the scheduler is still running but cannot see the work items. A scheduler that is alive but blind must not look like a scheduler with nothing to do. See [ADR-0034](../adr/0034-transient-failure-is-not-permanent-failure.md).

### Recovery policy

Execution must fail closed when required identity, manifest, claim, or verification evidence is missing or invalid. Recovery and reconciliation use the existing work-item identity and recorded state; reconciliation is not a shortcut for creating a new execution manifest. If the agent stops responding or verification cannot run, the system must preserve evidence and surface a recoverable state rather than treating the task as complete.

The verification branch is the branch an earlier attempt published its change request from. When it is still there, the verification reuses that change request and refreshes its evidence instead of refusing to create a second branch with the same name — the merge into the baseline rewrites the branch anyway. The implementation branch is deliberately different: a branch that already exists may hold work that was never pushed, so a worktree for it is refused rather than reused. A preparation that fails gives its sharing guard back, so the attempt that follows reaches the real failure instead of a double prepare.

**The claim on a worktree belongs to the attempt that took it.** The guard that keeps two concurrent attempts off one writable branch is released when the attempt ends — whether the attempt deletes its worktree or keeps it as the evidence of its failure. A failed verification keeps its worktree, and that is a decision about the files, not about the claim: a claim that outlived its attempt refused every later verification of the same item in the same process, with a double-prepare error instead of the failure that really happened. The takeover of a leftover worktree is deterministic — whatever stands at the path, whether the registration for this branch, the registration for another branch, or the files the earlier attempt left behind, is released before the branch is checked out again. Whether a path is a worktree is answered by the repository (`git worktree list --porcelain`), and paths are compared with their links resolved, because that is the form Git records them in: a localized Git says "not a working tree" in its own words, and AFK does not parse Git's sentences. See [ADR-0029](../adr/0029-worktree-claim-lifetime.md).

**AFK's own worktrees are invisible to the user's repository.** The worktrees live inside the checkout, so Git would report them as the user's uncommitted work and stage them as submodule pointers — a change request that carries a submodule nobody can clone. The checkout's local ignore file keeps them out of the repository's view, the commit that publishes the change unstages them and drops them from the index when an earlier attempt tracked them — it unstages rather than excluding them by pathspec, because Git refuses to add a path that is ignored, which is exactly what this decision makes of that path, and the preparer filters them out of the status it reads, the same way it filters `.afk/`. See [ADR-0030](../adr/0030-afk-worktrees-are-invisible.md).

## Related documents

- [Full Workflow & E2E Architecture](full-workflow-e2e-architecture.md)
- [Observability and Evidence](observability.md)
- [Architecture decision records](../adr/README.md)
