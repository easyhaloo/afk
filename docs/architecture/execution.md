# AFK Execution Environment and Multi-Agent Workflow Design

## 1. Goals

Transform AFK's execution layer into an extensible architecture without breaking existing Issue, Tracker, QA, HITL, and TUI capabilities:

```text
Issue Workflow
      ↓
Workflow Template
      ↓
Sandbox Provider
      ├── local
      │     └── git worktree + tmux
      ├── docker
      │     └── git worktree + container
      └── podman
            └── git worktree + container
      ↓
Agent Provider
      ├── claude-code
      ├── codex
      ├── cursor
      ├── pi
      ├── opencode
      └── copilot
```

Core requirements:

- `local` mode preserves the current `tmux + worktree` real-time interrupt capability
- `sandbox` unifies local and container execution environments
- Support for Runner to interrupt Agent in real-time before context grows past a threshold
- Support for session resume or handoff document recovery
- Support for multiple Agent Providers
- Support for branch strategies
- Support for composable workflow templates
- Source filenames, class names, comments, and user-facing text use only AFK's own concepts

## 2. Design Principles

### 2.1 Preserve Existing Business Layer

The following capabilities remain part of AFK's upper layer and are not migrated to Agent or Sandbox:

- GitHub/GitLab Tracker
- Issue labels
- AC extraction and verification
- PR/MR creation
- QA phase
- HITL state
- Scheduler / LoopRunner
- Board / Kanban TUI

### 2.2 Separate Four Concepts

```text
Agent Provider       = Agent CLI differences
Sandbox Provider     = Agent runtime environment differences
Branch Strategy      = Git branch and worktree strategy
Workflow Template    = Multi-step business process
```

Do not create combined classes of Agent, execution environment, and business process; use composition instead:

```text
Claude Code + local sandbox + issue branch + sequential-review template
Codex + docker sandbox + named branch + planner template
```

### 2.3 tmux Is Not an Ordinary Log Container

`local` mode must preserve:

- Real-time prompt sending
- Real-time interrupt sending
- Context threshold-triggered handoff
- Session capture
- Human attach
- HITL takeover

Provider differences stay inside the Agent provider. OpenCode's interactive
TUI consumes the goal via a launch flag (`opencode --auto --prompt …`, which
auto-submits once the TUI is rendered), so the local sandbox never types the
prompt into its pane; OpenCode handles its own startup and completion still
flows through the shared `goal_complete` signal file. Model
selection is runtime configuration via `AFK_OPENCODE_MODEL` (`provider/model`),
never a hardcoded product default; batch mode uses `opencode run --format
json` with the goal on stdin. The OpenCode provider removes the leading
`/goal` command prefix before launching its TUI, preserving the full issue body
and completion protocol as ordinary prompt text; otherwise OpenCode expands
its own slash command and drops the remainder of a multiline prompt. Managed
QA resources retain the parent audit run ID so all attach entry points resolve
the same execution attempt.

### 2.4 Gradual Retirement of `.afk-signal.json`

Agents should no longer actively write control signals via prompt. The new control protocol uses:

- AgentProvider event stream
- Structured final result
- ExecutionHandle
- Runtime state file managed by AFK runtime

Old signal compatible reading is preserved during migration.

## 3. Directory Structure

```text
packages/
├── afk-core/                     # 纯领域：模型、reducer、事件、端口；无 Node/Electron/DOM 依赖
│   └── src/
│       ├── model.ts
│       ├── reducer.ts
│       ├── events.ts
│       ├── ports.ts
│       └── execution-base-policy.ts
│
├── afk-application/              # 用例层：只允许依赖 @afk/core
│   └── src/
│       ├── backlog/
│       ├── tracker/
│       └── work-items/
│
├── afk-infrastructure/           # 基础设施：可依赖 core 与 application
│   └── src/
│       ├── backlog/
│       ├── branches/             # base、issue、named、merge-to-head、existing
│       ├── git/
│       ├── io/
│       ├── observability/
│       ├── provider/
│       ├── shared/
│       └── tracker/
│
├── afk-execution/                # 执行运行时：可依赖 core、application、infrastructure、workflow-graph
│   └── src/
│       ├── application/          # agents、loop、modules、plugins、runtime、sessions、visualizations、workflows
│       ├── domain/               # agents、templates
│       ├── infrastructure/       # config、git、observability、process、runtime、sandbox、tmux
│       ├── observability/
│       └── shared/
│
└── afk-workflow-graph/           # 图引擎：ir、project、normalize、layout、routing、validate、receipt
    └── src/

src/                             # 根层：CLI 与 TUI
├── cli/                         # Commander 装配与命令注册表
├── views/                       # Ink TUI
├── coordinator/
├── plugin-sdk/
├── shared/
└── types/
```

The five package roots above are the enforced boundary (`pnpm architecture:check --check-packages`). `core` depends on nothing, `application` may reach only `@afk/core`, `infrastructure` may reach core and application, and `execution` may reach core, application, infrastructure, and `@afk/workflow-graph`. `WorktreeManager`, `TmuxClient`, `WorkflowRunner`, `HandoffCoordinator`, and `Watchdog` are wired through adapters inside `packages/afk-execution/`.

## 4. Core Interfaces

### 4.1 AgentProvider

```ts
export interface AgentProvider {
  readonly name: AgentProviderName;
  readonly capabilities: ReadonlySet<AgentCapability>;

  buildCommand(options: AgentCommandOptions): AgentCommand;
  parseLine?(line: string): AgentEvent[];
  getSessionUsage?(session: AgentSession): Promise<TokenUsage | undefined>;
  captureSession?(options: CaptureSessionOptions): Promise<SessionSnapshot>;
  restoreSession?(options: RestoreSessionOptions): Promise<void>;
}
```

Provider capabilities:

```ts
export type AgentCapability =
  | 'streaming'
  | 'structured-output'
  | 'usage'
  | 'resume'
  | 'fork'
  | 'interactive';
```

First batch registered: `claude-code`, `codex`, `cursor`, `pi`, `opencode`, `copilot`. Each Provider must explicitly declare capability differences; do not assume all support resume, fork, or structured output.

### 4.2 AgentEvent

```ts
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool-start'; name: string }
  | { type: 'tool-end'; name: string }
  | { type: 'session'; sessionId: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'result'; result: unknown }
  | { type: 'error'; error: Error };
```

`AgentEvent` is a runtime internal protocol and does not directly express Issue state.

### 4.3 SandboxProvider

```ts
export interface SandboxProvider {
  readonly name: SandboxProviderName;
  readonly isolation: IsolationLevel;
  readonly capabilities: ReadonlySet<SandboxCapability>;

  create(options: SandboxOptions): Promise<Sandbox>;
}
```

Providers: `local`, `docker`, `podman`.

Isolation levels:

```ts
export type IsolationLevel =
  | 'workspace'
  | 'process'
  | 'filesystem'
  | 'vm';
```

Capabilities:

```ts
export type SandboxCapability =
  | 'streaming-exec'
  | 'interrupt-process'
  | 'kill-process'
  | 'persistent-filesystem'
  | 'copy-files'
  | 'session-transfer';
```

### 4.4 Sandbox and AgentExecution

```ts
export interface Sandbox {
  readonly id: string;
  readonly worktreePath: string;
  readonly workspacePath: string;

  startAgent(options: AgentStartOptions): Promise<AgentExecution>;
  close(): Promise<void>;
}

export interface AgentExecution {
  readonly id: string;
  readonly sessionId?: string;
  readonly metadata: AgentExecutionMetadata;
  /** Where the agent's own transcript lives, when the provider writes one. */
  readonly telemetryPath?: string;

  waitForResult(options?: { completionTimeoutMs?: number; contextHighTokens?: number }): Promise<ExecutionResult>;
  interrupt(reason: InterruptReason): Promise<void>;
  kill(): Promise<void>;
  captureOutput(options?: CaptureOptions): Promise<string>;
  captureSession(): Promise<SessionSnapshot | undefined>;
}
```

The execution does not resume itself and it emits no events of its own. A
native resume restores the provider's session and starts a *new* execution
(`attemptNativeResume`); the handoff document is the other path.

`interrupt()` and `kill()` must be distinguished:

```text
interrupt = graceful stop, prepare for resume/handoff
kill      = forced termination, do not assume session is recoverable
```

## 5. Local Sandbox

`LocalSandboxProvider` unifies the current `git worktree + tmux` combination as a unified local execution environment:

```text
create
  → create/reuse worktree
  → create tmux session
  → start Agent
  → return AgentExecution

interrupt (on the execution)
  → tmux send Ctrl-C
  → wait for Agent flush
  → preserve worktree and session

kill (on the execution)
  → force-terminate the session
  → session state is not preserved

close (on the sandbox)
  → close tmux
  → close control mode
  → update worktree state
  → cleanup per branch strategy
```

`interrupt()` does not clean up worktree or delete session; `close()` is the
final resource release.

The runner stops the agent before a handoff asks it for a summary: the
handoff request is typed into the session the agent is working in, and an
agent mid-turn cannot answer it. The session is restarted right after the
summary, so the turn ends either way.

A native resume restores the provider's session and starts a new generation
(`attemptNativeResume`); when the provider cannot resume, the handoff
document carries the state into the new generation.

Local mode provides task isolation and real-time control, but is not a security isolation boundary: it cannot prevent Agent from accessing other host files, processes, or environment variables.

## 6. Container Sandbox

Version 1 Docker/Podman uses worktree bind mount:

```text
host:
  <repo>/.worktrees/issue-42

container:
  /workspace
```

Only mount:

```text
/workspace
/afk/session
/afk/result
```

Do not mount by default:

```text
entire host HOME
~/.ssh
~/.aws
Docker socket
other repositories
```

Use non-root user by default and inject environment variables via explicit allowlist. Agent process control must save container ID, exec ID, Agent PID, and process group information; first gracefully interrupt, wait for session flush, then kill process group after timeout, and finally forcibly terminate the container.

Version 1 uses "one container per workflow, only restart Agent process on each context handoff", preserving dependencies and cache while keeping generation boundaries clear.

## 7. Context Handoff

Context handoff must be independent of completion judgment:

```text
completion judgment ≠ context interrupt judgment
```

Flow:

```text
1. Runner reads AgentProvider usage/event
2. token reaches contextHighTokens
3. execution.interrupt()
4. wait for session flush
5. capture session and verify integrity
6. prefer native session resume
7. use handoff Markdown when resume is not supported or fails
8. start new generation
9. continue current workflow step
```

Handoff recovery documents are written to
`<worktree>/.afk/handoff/handoff-<backlogId>-<generation>.md`
(`packages/afk-execution/src/application/workflows/handoff.ts`).

### What is written where

A run leaves three kinds of trace, in three different places, written by three
different owners. They are not interchangeable: one is authoritative, one is a
projection, one is the desktop's own scratch space.

**The audit spine** — the authoritative, append-only record of the run. One
JSONL file per run, hash-chained, verified before it is replayed.

```text
~/.afk/events/<base64url(runId)>.jsonl
```

`AFK_EVENT_STORE_DIR` moves the root
(`packages/afk-infrastructure/src/observability/jsonl-event-store.ts`).

**The runtime record** — what the TUI and the desktop read to show progress,
heartbeat and phase. One file per run, moved from `active/` to `archive/` when
the run reaches a terminal state.

```text
~/.afk/runtime/tasks/
├── active/<base64url(runId)>.json
├── archive/<base64url(runId)>.json
└── diagnostics/<base64url(runId)>/
    ├── runtime.json
    ├── result.json
    └── output.log
```

(`packages/afk-execution/src/application/runtime/task-runtime.ts`.)

**The desktop execution workspace** — the checkout, the artifacts and the logs
of one desktop work item.

```text
~/.loop-workspace/<taskId>/
├── repositories/<project>/...
├── artifacts/
├── runtime/
├── logs/
└── diagnostics/
```

(`desktop-client/electron/services/execution-workspace-service.ts`.)

The per-run tree this section used to describe is gone, but its four entries
did not all die together, and the two that survived only moved:

| Was | Is now |
|---|---|
| `<worktree>/.afk/runs/<run-id>/request.json` | written nowhere — the writer that produced it was only reachable from its own test |
| `<worktree>/.afk/runs/<run-id>/events.jsonl` | the audit spine, `~/.afk/events/<base64url(runId)>.jsonl` |
| `<worktree>/.afk/runs/<run-id>/result.json` | `~/.afk/runtime/tasks/diagnostics/<base64url(runId)>/result.json` |
| `<worktree>/.afk/runs/<run-id>/output.log` | `~/.afk/runtime/tasks/diagnostics/<base64url(runId)>/output.log` |

`result.json` and `output.log` are written by `TaskRuntimeStore.writeDiagnostics`
and are read by the run centre; the tree they lived in was removed because
nothing in the production path ever created it.

Session files must use temp files, checksums, and atomic rename to avoid new generation reading half-written JSONL.

## 8. ExecutionResult

```ts
export interface ExecutionResult {
  version: 1;
  runId: string;
  status: 'completed' | 'blocked' | 'failed' | 'aborted' | 'timed_out';
  provider: string;
  sessionId?: string;
  exitCode?: number;
  structuredOutput?: unknown;
  usage?: TokenUsage;
  commits: string[];
  branch?: string;
  error?: {
    code: string;
    message: string;
  };
}
```

New WorkflowRunner reads `ExecutionResult` to advance business state. Agent no longer needs to actively write control signals.

Migration period read priority:

```text
1. AgentExecution result
2. result.json
3. old .afk-signal.json
```

## 9. Branch Strategy

```ts
export type BranchStrategy =
  | { type: 'issue'; iid: number }
  | { type: 'named'; branch: string }
  | { type: 'merge-to-head' }
  | { type: 'existing'; branch: string; worktreePath?: string };
```

Strategy responsibilities:

- resolve branch name
- prepare worktree
- finalize changes
- merge if required
- cleanup branch/worktree

Must be explicit: session fork does not equal branch fork, branch fork does not equal sandbox fork. Parallel steps must explicitly use independent branch/worktree.

### 9.1 What AFK leaves in the repository

AFK works inside the user's repository, so it leaves its own files there:
the worktrees it creates (`<repo>/.worktrees/`), the execution journal and
handoff documents (`<repo>/.afk/`), the completion signal the agent writes
(`<repo>/.afk-signal.json`), and the local Claude Code settings
(`<repo>/.claude/settings.local.json`).

None of them are the user's work, and `git add -A` picks them up — AFK runs
`git add -A` itself when it commits the agent's work. The worktree in
particular would be committed as an embedded repository: a gitlink nobody
else can fetch.

The one list of these artefacts lives in
`packages/afk-infrastructure/src/git/repo-exclude.ts`, and it is written
into the repository's own exclude file (`.git/info/exclude`). That file is
local to the repository and is never committed, so the user's history stays
clean without touching a file they track — and because git reads it for
every checkout of the repository, one write covers the main checkout and
the worktrees alike.

## 10. Workflow Template

Templates use YAML to describe steps, with prompts stored separately:

```yaml
name: sequential-review
version: 1

steps:
  - id: implement
    role: implementer
    prompt: prompts/implement.md
    phase: implementation
    completionKind: task
    branch:
      type: issue

  - id: review
    role: reviewer
    prompt: prompts/review.md
    phase: verification
    completionKind: task
    dependsOn:
      - implement

  - id: fix
    role: implementer
    prompt: prompts/fix.md
    phase: implementation
    completionKind: task
    dependsOn:
      - review
    when:
      step: review
      equals: failed
```

`phase` and `completionKind` are optional. `phase` is `implementation` or
`verification` and says where the step sits in the workflow's behaviour:
acceptance-criteria feedback is injected into implementation steps, and the
acceptance self-correction loop re-runs the verification phase.
`completionKind` is `task`, `qa` or `ac` and says which completion protocol the
agent speaks.

Both are resolved by the compiler onto the compiled step, so the runner never
compares a step id. A template that declares neither keeps working: the phase
and the kind are derived from the step's `role`. That is why a step named
`verify-ac` no longer decides anything by its name — the name is data, the
declaration is behaviour.

Built-in templates:

```text
issue-implementation
pre-merge-qa-verification
simple-loop
sequential-review
parallel-planner
planner-with-review
```

Current AFK two-phase Issue flow should first be extracted as `issue-implementation` built-in template:

```text
implement → verify-ac → publish-change → queue-qa
```

Template load priority:

```text
CLI specified path → project-level .afk/workflows → user-level ~/.afk/workflows → built-in templates
```

## 11. Configuration and CLI

CLI example:

```bash
afk run --backlog-id <id>
```

`afk run` claims one ready backlog item and drives it through the template the
item selects. Templates are resolved by
`packages/afk-execution/src/domain/templates/builtin.ts` and can be overridden
with `--template <name>`; the related flags are `--agent`, `--sandbox`,
`--execution-mode`, `--base-branch`, `--target-branch`, `--max-handoffs`,
`--context-high`, `--max-total-tokens` and `--hard-timeout`. There is no
`afk workflow` command group, and no `--iid` or `--branch-strategy` flag — the
item is selected by `--backlog-id` and the branch by `--base-branch`.

Configuration example:

```yaml
agent:
  provider: claude-code

sandbox:
  provider: local

branch:
  strategy: issue

workflow:
  template: issue-implementation
  contextHighTokens: 100000
  maxHandoffs: 3
  maxTotalTokens: 500000
```

Configuration priority: CLI → `.afk/config.yml` → environment variables → defaults.

## 12. Phased Development Plan

### Phase 0: Baseline and Interface Design

- Lock current test baseline
- Establish Agent, Sandbox, Execution, Session, Branch, Template types
- Do not change existing runtime behavior

Acceptance: `pnpm build`, `pnpm test` pass.

### Phase 1: Local Sandbox Compatible Integration

- Implement `LocalSandboxProvider`
- Wrap existing `WorktreeManager` and `TmuxClient`
- Change `WorkflowRunner` to depend on Sandbox/Execution interface
- Preserve existing context handoff, watchdog, and HITL

Acceptance: existing tmux workflow behavior unchanged; context threshold during execution can trigger interrupt and handoff.

### Phase 2: Event Stream and Result Protocol

- Implement `AgentEvent`
- Implement `ExecutionResult`
- Add run state directory
- Agent results prefer structured protocol
- Preserve `.afk-signal.json` fallback

Acceptance: structured completion, failure, blocked, timeout, and invalid results all have tests.

### Phase 3: Multiple Agent Providers

Establish and register all at once:

- Claude Code
- Codex
- Cursor
- Pi
- OpenCode
- Copilot

Each Provider implements independent command builder, stream parser, and capability matrix.

Acceptance: each Provider has fixture tests; Providers that do not support resume must not incorrectly enter resume flow.

### Phase 4: Session Store and Handoff Enhancement

- Implement provider-specific session store
- Prefer native resume
- Fallback to handoff Markdown on failure
- Save generation, checksum, and recovery metadata

Acceptance: new generation after context limit can continue current stage; session corruption can safely degrade.

### Phase 5: Docker/Podman Sandbox

- Implement container creation and cleanup
- worktree bind mount
- non-root user
- environment variable allowlist
- streaming exec
- process group interrupt/kill
- generation restart within same container

Acceptance: Agent in container can modify host worktree; context handoff, failure cleanup, and container recovery work correctly.

### Phase 6: Branch Strategy

- `issue`
- `named`
- `merge-to-head`
- `existing`

Acceptance: each strategy has Git fixture/integration test; parallel workflows do not share writable branch/worktree.

### Phase 7: Workflow Template

- Implement template schema, loader, registry
- Extract existing flow as `issue-implementation`
- Add `simple-loop`
- Add `sequential-review`
- Add `parallel-planner`
- Add `planner-with-review`

Acceptance: templates can express dependencies, conditions, execution modes, Agent, branch strategy, and structured output.

### Phase 8: Remove Old Signal Protocol

Prerequisite: all new workflows and default Provider use ExecutionResult.

- Delete signal writing requirements from new prompts (`packages/afk-execution/src/domain/templates/builtin.ts`, the workflow phases)
- Runner still reads signal as backward-compatible fallback (`packages/afk-execution/src/infrastructure/tmux/tmux.ts`)
- Clean up legacy signal CLI/schema/tests (preserve readSignal/writeSignal/clearSignal + unit tests; CLI/skills have no independent signal subcommand yet)
- Update skills, README, and architecture docs (`CLAUDE.md` contains Phase status table)

Acceptance: full test suite passes, old worktrees can be compatibly read or explicitly migrated.

Implementation details:
- Batch agents report via `ExecutionResult`; interactive agents write `.afk-signal.json` per `packages/afk-execution/src/application/workflows/execution-protocol.ts`, read via `readSignal`/`readSignalSync` in `packages/afk-execution/src/infrastructure/tmux/tmux.ts`.
- `packages/afk-infrastructure/src/io/signal.ts` owns the signal file primitives.

## 13. Testing Plan

### Unit Tests

Coverage:

- Provider command construction
- stream event parsing
- usage aggregation
- capability detection
- invalid result
- interrupt/kill distinction
- session capture/restore
- branch strategy
- template dependency resolution

### Local Sandbox Integration Tests

Use fake Agent process to verify:

- context threshold interrupt
- resume after handoff
- timeout
- manual abort
- tmux cleanup
- worktree preservation

### Docker/Podman Integration Tests

Verify when runtime is available:

- worktree mount
- environment variable allowlist
- non-root user
- process interrupt
- subprocess cleanup
- session transfer
- container cleanup

### End-to-End Tests

```text
Issue
→ template
→ sandbox
→ Agent
→ context handoff
→ completion
→ branch finalization
→ PR/MR
```

## 14. Documentation Sync

Needs sync:

- `README.md`
- `CLAUDE.md`
- `docs/architecture/overview.md`
- `docs/guides/workflows.md`
- `docs/getting-started.md`
- `docs/guides/testing.md`
- `docs/guides/skills.md`

Documentation must explain:

1. `local` is task isolation, not security isolation
2. Docker/Podman mount boundaries
3. Agent Provider capability differences
4. context handoff real-time interrupt flow
5. branch strategy
6. workflow template
7. session resume and handoff fallback
8. `.afk-signal.json` migration status

Also fix implementation drift in existing architecture docs:

- Scheduler is actually an in-memory queue, not BullMQ/Redis
- AC verification docs need to match current WorkflowRunner actual flow
- Default timeout follows the `--hard-timeout` option of `afk run` (`src/cli/commands/run.ts`)

## 15. Final Architecture

```text
afk run --backlog-id <id>
        │
        ▼
WorkflowTemplate
        │
        ▼
WorkflowRunner
        │
        ├── TrackerProvider
        ├── BranchStrategy
        ├── SandboxProvider
        └── AgentProvider
                │
                ▼
         AgentExecution
                │
       ┌────────┼────────┐
       │        │        │
   events    usage    result
       │        │        │
       └────────┼────────┘
                │
       context threshold?
          ├── no → continue
          └── yes
                │
          interrupt()
                │
          capture session
                │
          resume / handoff
                │
          continue workflow
```

Final responsibilities:

- `Worktree`: code and branch isolation
- `Sandbox`: Agent execution environment
- `ExecutionHandle`: real-time output, interrupt, resume
- `AgentProvider`: different Agent CLI adapters
- `SessionStore`: context handoff
- `BranchStrategy`: branch and worktree lifecycle
- `WorkflowTemplate`: multi-step process definition
- `WorkflowRunner`: Issue business state and overall orchestration
