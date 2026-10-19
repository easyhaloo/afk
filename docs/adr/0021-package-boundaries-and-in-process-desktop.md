# ADR-0021: Package boundaries and the in-process desktop client
## Status
Accepted
## Context
The desktop client drove AFK through the CLI. Every backlog read, backlog
control command, work item execution, workflow graph generation and version
probe spawned `afk` and parsed a JSON envelope back out of it. That put a
process launch, a PATH lookup, a timeout and an output buffer in the middle of
every call, and it put the provider SDK behind a subprocess boundary that could
not be reused.

The cost was measurable. Listing the work item inventory issued one request per
credential-accessible project — 138 requests, 16.1s on a repository with 102
GitHub and 36 GitLab projects — and a project the token could not read came
back as a permission failure. The desktop also depended on the root package's
`src/` tree: the provider inventory bundle imported the tracker factory
directly, so a source file under `src/infrastructure` was part of the desktop's
public surface.

A second problem sat underneath: the backlog auto-run path was broken. The
desktop spawned `afk loop --backlog-id <id> --max-iterations 1`, but the CLI
requires a managed execution — a work item id and an execution manifest — and
rejected the arguments outright. The detached spawn discarded stderr, so the
desktop recorded "failed, exit code 1" and the actual reason never reached the
user.

`docs/architecture/blueprints/core-layer-architecture_zh.md` had already named
the target: use cases that both the CLI and the desktop call, with providers
behind ports, and infrastructure that only points inwards.
## Decision
Split the shared capability into four workspace packages, and make the desktop
a composition root that calls the same use cases the CLI does.

- `packages/afk-core` — the business kernel. Unchanged.
- `packages/afk-application` — use cases and the Port interfaces they are
  written against. It may depend on `@afk/core` and on nothing else: no Node
  builtins, no provider SDKs. It now owns the backlog model and commands, the
  work item identity, metadata and inventory orchestration, the tracker types,
  and the structured error vocabulary.
- `packages/afk-infrastructure` — the implementations behind those ports:
  provider SDK clients, the tracker provider factory, the git and branch
  adapters, change-request adapters, the filesystem claim lock, the logger and
  the JSONL event store. Node builtins and provider SDKs belong here.
- `packages/afk-execution` — the work item execution runtime: the workflow and
  QA orchestration, the agent runtimes, the sandbox, tmux, the templates and the
  session stores. This is a transitional shape; splitting its use cases into
  ports so that `executeWorkItem` itself can move to `@afk/application` is
  follow-up work.

The root package keeps the CLI and the TUI. The architecture guard becomes
table driven per package, and gains a rule the packages already implied: the
desktop client may consume `@afk/*` but must not import the root package's
`src/` tree.

The desktop stops spawning the CLI. It holds a composition root that assembles
the provider ports, and it calls `listBacklogs`, `interruptBacklog`,
`executeWorkItem` and `generateWorkflowGraph` in process. The backlog auto-run
delegates to the work item execution instead of spawning `afk loop`, which is
what makes that path work at all.

The work item inventory lists the scope in one round trip where the platform
can filter server-side — a GitHub issue search per repository owner, GitLab's
global issue feed — restricted to the projects that were discovered, with the
per-project listing kept as the fallback. The concurrency ceiling moves from 4
to 12 because the listing is network bound.
## Consequences
The desktop and the CLI now run the same code for the same operation, which is
the invariant the blueprint asked for and which no longer depends on two
implementations agreeing on a wire format. The JSON envelope survives as the
CLI's `--json` output, but it is no longer a boundary the desktop has to
cross.

Measured on the same workspace: the work item inventory goes from 16.1s to
4.3s with the same 158 items and the same 138 projects, and it is complete
rather than carrying a permission diagnostic. The backlog list goes from a
subprocess that took seconds to an in-process call, and the desktop no longer
needs an installed CLI, a PATH entry or a version probe.

The cost is bundle size. The desktop's main process now inlines the execution
runtime, 441K to 2.6M, and the package that carries the work item execution
became part of the desktop's dependency set.

`@afk/execution` still mixes use cases with their implementations, so the
port discipline that `@afk/application` and `@afk/infrastructure` follow is not
yet applied to the execution runtime. The guard cannot enforce it there.
