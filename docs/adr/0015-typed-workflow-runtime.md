# ADR-0015: Typed Workflow Runtime Boundaries

## Status

Accepted

### Backlog provider boundary

The workflow runtime now treats backlog as a canonical domain object rather than a tracker issue. `BacklogProvider` owns state, execution mode, dependencies, parent relationships, and atomic claiming. `BranchProvider` and `ChangeProvider` remain separate ownership boundaries; no `BacklogExecutionService` is introduced. GitHub/GitLab labels are mapped only by adapters, allowing a future Linear/Jira adapter without runner changes.

## Decision

Workflow requests are normalized into `WorkflowRunRequest` with an explicit
`ProjectContext`; cross-project execution never changes `process.cwd()`.
Templates compile into typed `agent` and `system` steps. The only bundled
system actions are `publish-change` and `queue-qa`; arbitrary YAML shell
actions are not supported.

Resources created for a run belong to `RunResourceScope`, whose idempotent
terminalizer closes executions and sandboxes, finalizes once, and applies the
success/failure cleanup policy. Lifecycle hooks have explicit ordered phases:
`init`, `before-agent`, `after-agent`, and reverse-order `cleanup`.

Plugins use `PluginRuntime` and may register typed lifecycle modules, agent or
sandbox providers, templates, and system actions. They receive no shell or
resource-scope access.

## Consequences

Provider, sandbox, template, and plugin extensions attach at typed boundaries
without adding task-specific branches to `WorkflowRunner`. Legacy role-based
v1 template steps remain supported and are normalized by the compiler. The QA
template is named `pre-merge-qa-verification`: it tests an MR candidate merged
into a temporary baseline worktree before the remote MR is merged.
