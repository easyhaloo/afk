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

### 2.4 Gradual Retirement of `.afk-signal.json`

Agents should no longer actively write control signals via prompt. The new control protocol uses:

- AgentProvider event stream
- Structured final result
- ExecutionHandle
- Runtime state file managed by AFK runtime

Old signal compatible reading is preserved during migration.

## 3. Target Directory Structure

```text
src/lib/
├── agents/
│   ├── types.ts
│   ├── provider.ts
│   ├── registry.ts
│   ├── runner.ts
│   ├── claude-code.ts
│   ├── codex.ts
│   ├── cursor.ts
│   ├── pi.ts
│   ├── opencode.ts
│   └── copilot.ts
│
├── sandbox/
│   ├── types.ts
│   ├── factory.ts
│   ├── registry.ts
│   ├── local.ts
│   ├── docker.ts
│   └── podman.ts
│
├── execution/
│   ├── types.ts
│   ├── events.ts
│   ├── handle.ts
│   ├── process.ts
│   ├── lifecycle.ts
│   └── errors.ts
│
├── sessions/
│   ├── types.ts
│   ├── store.ts
│   ├── local.ts
│   ├── file-transfer.ts
│   └── handoff.ts
│
├── branches/
│   ├── types.ts
│   ├── strategy.ts
│   ├── issue.ts
│   ├── named.ts
│   ├── merge-to-head.ts
│   └── existing.ts
│
└── templates/
    ├── types.ts
    ├── registry.ts
    ├── loader.ts
    └── builtin/
        ├── issue-implementation/
        ├── simple-loop/
        ├── sequential-review/
        ├── parallel-planner/
        └── planner-with-review/
```

Existing `WorktreeManager`, `TmuxClient`, `WorkflowRunner`, `HandoffCoordinator`, and `Watchdog` are connected via adapters first, without large-scale file reorganization.

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

  waitForEvent(): Promise<ExecutionEvent>;
  waitForResult(): Promise<ExecutionResult>;
  interrupt(reason: InterruptReason): Promise<void>;
  kill(): Promise<void>;
  captureOutput(options?: CaptureOptions): Promise<string>;
  captureSession(): Promise<SessionSnapshot | undefined>;
  resume(options: ResumeOptions): Promise<AgentExecution>;
}
```

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

interrupt
  → tmux send Ctrl-C
  → wait for Agent flush
  → capture session
  → preserve worktree

resume
  → new generation tmux session
  → restore session or read handoff
  → continue execution

close
  → close tmux
  → close control mode
  → update worktree state
  → cleanup per branch strategy
```

`interrupt()` does not clean up worktree or delete session; `close()` is the final resource release.

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

Run state directory:

```text
<worktree>/.afk/runs/<run-id>/
├── request.json
├── events.jsonl
├── result.json
├── output.log
└── handoff/
    ├── handoff-1.md
    └── handoff-2.md
```

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

## 10. Workflow Template

Templates use YAML to describe steps, with prompts stored separately:

```yaml
name: sequential-review
version: 1

steps:
  - id: implement
    role: implementer
    prompt: prompts/implement.md
    branch:
      type: issue

  - id: review
    role: reviewer
    prompt: prompts/review.md
    dependsOn:
      - implement

  - id: fix
    role: implementer
    prompt: prompts/fix.md
    dependsOn:
      - review
    when: review.status == "failed"
```

Built-in templates:

```text
issue-implementation
simple-loop
sequential-review
parallel-planner
planner-with-review
```

Current AFK two-phase Issue flow should first be extracted as `issue-implementation` built-in template:

```text
implement → verify-ac → create-mr → qa
```

Template load priority:

```text
CLI specified path → project-level .afk/workflows → user-level ~/.afk/workflows → built-in templates
```

## 11. Configuration and CLI

CLI example:

```bash
afk workflow run \
  --iid 42 \
  --agent claude-code \
  --sandbox local \
  --branch-strategy issue \
  --template issue-implementation
```

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

- Delete signal writing requirements from new prompts (`templates/builtin.ts`, `workflows.ts` phases)
- Runner still reads signal as backward-compatible fallback (`sandbox/legacy-compat.ts`)
- Clean up legacy signal CLI/schema/tests (preserve readSignal/writeSignal/clearSignal + unit tests; CLI/skills have no independent signal subcommand yet)
- Update skills, README, and architecture docs (`CLAUDE.md` contains Phase status table)

Acceptance: full test suite passes, old worktrees can be compatibly read or explicitly migrated.

Implementation details:
- `sandbox/legacy-compat.ts` — `readLegacySignalResult()` maps `.afk-signal.json` to `ExecutionResult`.
- `LocalAgentExecution.waitForResult` calls legacy adapter as fallback.
- `core/io/signal.ts` top has `@deprecated` JSDoc.

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
- `docs/ARCHITECTURE.md`
- `docs/WORKFLOWS.md`
- `docs/GETTING-STARTED.md`
- `docs/TESTING.md`
- `docs/SKILLS.md`

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
- Default timeout follows `src/lib/constants.ts`

## 15. Final Architecture

```text
afk workflow run
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
