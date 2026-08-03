# AFK Architecture

## Design Goals

The core problem AFK (Away From Keyboard) solves is: **enabling AI agents to automatically complete Issues in an isolated environment and produce mergeable MRs**.

To achieve this, the system must address four challenges:

| Challenge | Solution |
|-----------|----------|
| Platform Differences | TrackerProvider abstraction layer, unified GitLab/GitHub interface |
| Concurrent Interference | git worktree physical isolation + tmux session isolation |
| State Synchronization | Signal files + statusline JSON + bidirectional label sync |
| Runaway Protection | Watchdog hard timeout + retry escalation to HITL |

---

## Core Architecture

### Directory Structure

```
src/
├── index.ts              # Thin CLI dispatcher (lazy-loads commands)
├── command-registry.ts   # Single source of truth for all commands
├── lazy-loader.ts        # Per-command dynamic import
├── full-cli.ts           # Fallback: loads all commands for unknown commands
├── commands/             # Individual command implementations
│   ├── signal.ts         # Signal file management
│   ├── tracker.ts        # Issue/MR CRUD (issue, mr commands)
│   ├── tmux.ts           # Tmux session management
│   ├── worktree.ts       # Git worktree list/clean
│   ├── workflow.ts       # Workflow orchestration
│   ├── scheduler.ts      # Background scheduler CLI wrapper
│   ├── board.ts          # TUI dashboard
│   ├── kanban.ts         # Kanban board
│   ├── debug.ts          # Debug loop (reproduce → verify)
│   ├── escalate.ts       # File issue + launch workflow
│   ├── isolate.ts        # DB service isolation per worktree
│   ├── qa.ts             # QA verification
│   ├── loop.ts           # Continuous integration loop
│   ├── completion.ts     # Shell completion
│   └── board-entry.ts    # TUI entry point (Ink + React)
├── lib/
│   ├── core/             # Platform clients, IO, git, config, tmux
│   │   ├── config/       # Workflow configuration
│   │   ├── git/          # Git operations (WorktreeManager)
│   │   ├── github/       # GitHub client (@octokit/rest)
│   │   ├── gitlab/       # GitLab client (@gitbeaker/node)
│   │   ├── io/           # Signal, status, statusline, logger
│   │   ├── tmux/         # Tmux client
│   │   └── tracker/       # Tracker abstraction (types, detect, ac)
│   ├── agents/           # Agent providers (claude-code, cursor, copilot, etc.)
│   ├── branches/         # Branch strategies (issue, named, existing, merge-to-head)
│   ├── modules/          # Lifecycle modules (loop-runner, qa-runner, isolate)
│   │   ├── _registry.ts  # Module loader
│   │   ├── loop-runner.ts
│   │   ├── qa-runner.ts
│   │   ├── isolate.ts
│   │   └── project-resolver.ts
│   ├── sandbox/          # Sandbox providers (local, container)
│   │   ├── container/    # Docker/Podman sandbox
│   │   ├── providers/    # Sandbox provider registry
│   │   └── types.ts      # Sandbox, ExecutionResult interfaces
│   ├── scheduler.ts      # Scheduler logic (in-memory queue, no Redis)
│   ├── sessions/         # Session stores (file, handoff, chain)
│   ├── templates/        # Workflow templates (registry, resolver, builtin)
│   ├── workflows/        # Workflow execution (lifecycle, handoff, watchdog, budget)
│   ├── plugins/          # Skill plugin loader
│   ├── completion/       # Shell completion utilities
│   └── stats/            # Statistics
├── views/                # TUI views (Ink + React)
│   ├── app/              # Main app views
│   └── board/            # Dashboard, kanban, navigation, registry
└── types/                # Shared TypeScript types
```

### Module Dependency Graph

```mermaid
graph TD
    CLI["CLI Entry (index.ts)"]
    REG["command-registry.ts"]
    LZ["lazy-loader.ts"]
    FULL["full-cli.ts (fallback)"]
    Factory["createTrackerClient Factory"]
    Detect["detectProject Platform Detection"]
    GL["GitLabClient"]
    GH["GitHubClient"]
    AC["AC Extraction (tracker/ac.ts)"]
    Runner["WorkflowRunner Orchestration"]
    Sandbox["SandboxProvider"]
    Agent["AgentProvider (claude-code)"]
    WT["WorktreeManager (git worktree)"]
    TMUX["TmuxClient Session Management"]
    SIG["Signal I/O (.afk-signal.json)"]
    STATUS["Status I/O (.afk/claude-status.json)"]
    Sched["Scheduler (in-memory)"]
    Modules["Lifecycle Modules (loop-runner, qa-runner)"]
    Templates["Template Registry"]
    HC["HandoffCoordinator"]
    Budget["BudgetManager"]
    Watchdog["Watchdog"]

    CLI --> REG
    CLI --> LZ
    LZ -->|unknown cmd| FULL
    CLI --> Factory
    Factory --> Detect
    Factory --> GL
    Factory --> GH

    CLI --> Runner
    GL --> Runner
    GH --> Runner
    GL --> AC
    GH --> AC

    Runner --> WT
    Runner --> TMUX
    Runner --> Sandbox
    Runner --> Agent
    Runner --> Modules
    Runner --> Templates
    Runner --> HC
    Runner --> Budget
    Runner --> Watchdog
    Runner --> Sched

    Modules --> Runner
    Templates --> Runner

    Agent -. tmux session .-> TMUX
    Agent -. write signal .-> SIG
    Agent -. stdin JSON per turn .-> STATUS
    SIG -. polling .-> Runner
    STATUS -. on demand .-> Runner

    classDef cli fill:#e1f5ff,stroke:#0066cc
    classDef core fill:#fff4e1,stroke:#cc6600
    classDef io fill:#f0e1ff,stroke:#6600cc

    class CLI,REG,LZ,FULL,Agent cli
    class Runner,Factory,GL,GH,Sched,Modules,Templates,Watcher core
    class WT,TMUX,SIG,STATUS,Sandbox,AC,HC,Budget io
```

### Module Responsibilities

| Module | Responsibility | Key Design Decision |
|--------|---------------|---------------------|
| **command-registry.ts** | Single source of truth for all CLI commands | One array feeds both lazy-loader and full-cli |
| **lazy-loader.ts** | Per-command dynamic import | Fast path: ~50ms cold start |
| **full-cli.ts** | Load-all fallback for unknown commands | Parallel `Promise.all` load |
| **index.ts** | Thin CLI dispatcher | No shared logging at import time |
| **WorkflowRunner** | Orchestrates complete lifecycle | Template-driven + handoff + budget + AC objective verification |
| **SandboxProvider** | Agent runtime environment abstraction | Local (tmux) or container (Docker/Podman) |
| **AgentProvider** | AI agent abstraction | claude-code, cursor, copilot, codex, opencode, pi |
| **HandoffCoordinator** | Context overflow management | Negotiate summary → persist doc → post comment → relaunch |
| **BudgetManager** | Token and handoff budget tracking | Tracks total tokens across handoff generations |
| **Watchdog** | Hard timeout protection | `setsid` independent process, triggers even if parent crashes |
| **AC Extraction** | Extract AC from issue labels / legacy markdown | Label-driven first, markdown as fallback |
| **WorktreeManager** | Independent workspace per Issue | Physical isolation, no branch conflicts |
| **TmuxClient** | Agent runtime environment | Independent sessions, crashes don't affect each other |
| **Signal I/O** | Agent-Runner control communication (interactive mode) | Atomic file writes, Zod validation; batch mode uses event stream (see [ADR-0014](./adr/0014-interactive-and-batch-structured-output.md)) |
| **Status I/O** | Read Claude statusline JSON | Token objective data source |
| **Scheduler** | Multi-Issue concurrent scheduling | In-memory queue + priority, no Redis dependency |
| **Lifecycle Modules** | Extensible runners | loop-runner (continuous), qa-runner (verification), isolate (DB isolation) |
| **Template Registry** | Workflow template loading | Built-in templates + custom template support |

---

## Key Design Decisions

### 1. Why File Signals Instead of IPC?

Agents run in tmux sessions, which are **process-isolated** from the scheduler. Three communication approaches were considered:

| Approach | Advantages | Rejection Reason |
|----------|------------|------------------|
| Unix Socket | Low latency | Complex cross-process lifecycle management, socket residue after Agent crash |
| HTTP Long Poll | Bidirectional push | Requires a persistent service inside the Agent, violates "non-invasive" principle |
| **File Signals** | **Recoverable state after process crash** | **Adopted** |

**Key Design:**
- Atomic writes (tmp + rename), avoid reading half-written JSON
- Zod schema validation, fast failure on version incompatibility

### 1b. Context Overflow Detection

**Runner polls statusline, Agent doesn't participate**: Runner reads token count from `<worktree>/.afk/claude-status.json` each polling cycle (statusline writes each turn), and compares against `CONTEXT.HIGH_THRESHOLD` (default 100K). When threshold is reached, handoff is triggered. There is no context_high in the signal protocol.

This avoids "the evaluated judging itself" bias — LLM self-assessment of its own state is unreliable (TUI warnings are invisible at the rendering layer), so the system should make decisions based on objective data.

### 1c. AC Expressed via Issue Labels, Not Markdown Regex

Neither GitLab nor GitHub APIs return structured checklists. The original regex parsing of `- [ ]` was extremely brittle — variants like Chinese titles, indentation, emojis, numbered lists all broke it.

**Switch to label-expressed AC**: Each AC item is a label (`ac::1:: User can log in`), platform APIs directly return structured arrays, enabling server-side filtering.

Legacy markdown sections are kept as fallback (best-effort), no migration needed. See `src/lib/core/tracker/ac.ts`.

### 1d. Why Not Pane Capture + Regex for State Detection?

Agent state detection (prompt ready, timeout triggered, signal complete) always uses:
- **File signals** (`.afk-signal.json`)
- **Status files** (`.afk/claude-status.json`)
- **Structured APIs** (Direct GitLab/GitHub SDK calls)

Not `tmux capture-pane` + regex/string matching, because:
- Claude Code UI theme/font changes can change characters
- Pane output depends on color codes, ANSI escapes
- Multi-pane boundaries and wide characters make regex error-prone

Remaining `capturePane` calls are only used for **writing log snapshots** (ops archival) and CLI `afk tmux capture` (user-initiated), not for state detection.

### 2. Why Worktree Instead of Docker?

| Approach | Startup Overhead | Isolation Strength | Disk Usage |
|----------|-----------------|-------------------|------------|
| Docker container | 5-10s | Process-level | GB/container |
| **git worktree** | **<1s** | **File-level** | **MB/worktree** |

What the Agent needs is **branch isolation**, not **process isolation**. Worktrees share the `.git` directory but have independent working trees, with near-zero switching overhead.

### 3. Why Watchdog?

Agents can get stuck for the following reasons:
- Waiting for user input (shouldn't happen, but does with skill design flaws)
- Infinite loops or recursive calls
- Network request hangs

**Two layers of protection:**
- `completionTimeoutMs` (default 5min): Soft timeout, triggers signal detection
- `hardTimeoutMs` (default 60min): Hard timeout, watchdog directly `kill-session`

Watchdog starts as an independent process via `setsid`, **triggering even if the parent process crashes**.

### 4. Why Retry on AC Failure Instead of Directly Escalating to HITL?

Common causes of AC failure:
- Agent misunderstood requirements (50%) — Retry + clearer AC often passes
- Actual implementation defect (30%) — Retry + code fixes
- Requirements issue itself (20%) — Needs HITL

Direct escalation to HITL surrenders 80% of automatable scenarios to humans. **Retry mechanism preserves the core value of automation**.

---

## Cross-Platform Abstraction Layer

### Layered Architecture

```mermaid
graph TD
    Biz["Business Code (WorkflowRunner / Commands)"]
    IF["TrackerProvider Interface Contract"]
    GL["GitLabClient (@gitbeaker/node)"]
    GH["GitHubClient (@octokit/rest)"]
    GL_API["GitLab REST API"]
    GH_API["GitHub REST API"]

    Biz -->|only depends on| IF
    IF -.implement.-> GL
    IF -.implement.-> GH

    GL --> GL_API
    GH --> GH_API

    classDef biz fill:#e1f5ff
    classDef impl fill:#fff4e1
    class IF biz
    class GL,GH impl
```

**Core Principle: Differences are encapsulated inside clients, interfaces maintain semantic consistency.**

### Platform Difference Handling

| Difference | GitLab | GitHub | Abstraction Strategy |
|------------|--------|--------|----------------------|
| Issue ID | `iid` | `number` | Unified to `id: number` |
| Adding labels on MR creation | Native API support | Requires extra API call | GitHubClient handles automatically internally |
| Delete branch on merge | `removeSourceBranch` parameter | Separate `git.deleteRef` | Encapsulated in `mergeMR()` |
| Issue linking | Native `Issues.link()` | Can only comment reference | GitHubClient degrades to comment |

### Platform Detection Flow

```mermaid
flowchart TD
    Start([Start]) --> Env{"TRACKER_PLATFORM env set?"}
    Env -->|set| ReturnEnv[Return specified platform]
    Env -->|not set| Remote[Parse git remote URL]
    Remote --> RemoteCheck{URL domain?}
    RemoteCheck -->|github.com| GH[GitHub]
    RemoteCheck -->|gitlab.com| GL[GitLab]
    RemoteCheck -->|other| Config[Check config files]
    Config --> ConfigCheck{Found?}
    ConfigCheck -->|.github/workflows| GH
    ConfigCheck -->|.gitlab-ci.yml| GL
    ConfigCheck -->|neither| Default[Default to GitLab]

    classDef detected fill:#d4edda,stroke:#28a745
    class GH,GL detected
```

**Detection Priority:** Environment variable > git remote > config files > Default GitLab

---

## Signal Protocol

### Two Data Channels

The system communicates with the Agent via two channels, each with different focus:

| Channel | Data | Written By | Read By | Purpose |
|---------|------|------------|---------|---------|
| `.afk-signal.json` | Control events | Agent | Runner polling | goal_complete / ac_result / timeout / handoff_ready |
| `.afk/claude-status.json` | Objective state | Claude Code statusline | Runner on demand | Token count, model, context window |

**Design Principle: Control signals go through files (Agent-initiated), state data through statusline (engine auto-push).**

### Signal Types (Control Channel)

| Signal | Trigger Scenario | System Response |
|--------|-----------------|-----------------|
| `goal_complete` | Agent completed goal | Enter AC acceptance |
| `ac_result` | AC check result | PASS-create MR, FAIL-retry or escalate |
| `timeout` | Hard timeout | Capture logs, add `mode::timeout` label |
| `handoff_ready` | Context switch complete | Close old session, start new session |

Context overflow is not a signal: Runner directly triggers handoff after polling statusline token count and comparing against `CONTEXT.HIGH_THRESHOLD`.

### Signal Lifecycle

```mermaid
sequenceDiagram
    participant A as Agent
    participant FS as .afk-signal.json
    participant R as WorkflowRunner
    participant H as Handler

    loop Execution Loop
        A->>A: Work progress
        A->>FS: Write signal (atomic write)
        Note over FS: tmp + rename

        R->>FS: Poll (2s interval)
        alt Signal matches expected type
            FS-->>R: Return signal
            R->>H: Dispatch to corresponding handler
        else Type mismatch
            FS-->>R: null
            R->>R: Continue polling
        end
    end

    opt Timeout
        R->>R: Wait exceeded completionTimeoutMs
        R->>H: Trigger timeout handler
    end
```

### State Data Flow (Status Channel)

Claude Code statusline auto-pushes JSON payload via stdin each turn. AFK auto-configures statusline on worktree creation to use tee command to write to file simultaneously, and writes a placeholder file so Runner can immediately detect prompt-ready:

```mermaid
sequenceDiagram
    participant W as WorkflowRunner
    participant SCONF as configureStatusline
    participant JSON as .afk/claude-status.json
    participant CC as Claude Code Engine
    participant Tee as tee (statusline entry)
    participant SL as ccstatusline render

    W->>SCONF: Write settings.json + placeholder status
    SCONF->>JSON: Write placeholder (startup immediately detectable)
    W->>JSON: fs.access - Returns true immediately

    Note over CC: Claude TUI starts, first turn begins
    loop Each turn
        CC->>Tee: stdin JSON (model, tokens, cost...)
        Tee->>JSON: Write real payload (overwrites placeholder)
        Tee->>SL: Pass through to user render
    end

    Note over W: Runner reads each polling cycle
    W->>JSON: readClaudeStatus(worktreeDir)
    JSON-->>W: Return after Zod validation
    W->>W: extractTokenUsage - Threshold check
```

**Status JSON schema (Zod):**

```typescript
{
  model: { display_name: string },
  context_window: {
    context_window_size: number,           // e.g., 200000
    current_usage: {
      input_tokens: number,
      output_tokens: number,
      cache_creation_input_tokens: number,
      cache_read_input_tokens: number,
    }
  },
  session_id: string,
  // ... other fields ignored
}
```

### Why Zod Validation?

Signal files cross process boundaries, **format errors are the norm, not the exception**:
- Agent skill version mismatch
- Manually edited test signals
- Network issues causing write interruption

Zod fails fast at the boundary, better than letting errors like `undefined.sha` propagate and crash deep in the system.

---

## WorkflowRunner Flow

### Core Architecture

The WorkflowRunner uses a **template-driven, multi-phase design**:

```mermaid
graph TD
    Start[run options] --> Init[Initialize tracker, tmux, sandbox]
    Init --> Resolve[Resolve template & branch strategy]
    Resolve --> LoadModules[Load lifecycle modules]
    LoadModules --> Plan[Resolve execution plan from template]
    Plan --> ExecutePhases

    subgraph ExecutePhases
        P1[Phase 1: Implement] --> Poll1[Poll signals / context]
        Poll1 --> Check1{goal_complete?}
        Check1 -->|yes| P2[Phase 2: Verify]
        Check1 -->|context_high| HC[HandoffCoordinator]
        HC --> Resume1[Resume with summary]
        Resume1 --> P1
        Poll1 -->|timeout| WD[Watchdog]
    end

    P2 --> Poll2[Poll for ac_result]
    Poll2 --> Check2{ac_pass?}
    Check2 -->|yes| Wrapup[autoWrapup]
    Check2 -->|no| Retry{retry < max?}
    Retry -->|yes| NewSess[New session]
    Retry -->|no| HITL[Escalate to HITL]
    NewSess --> P1
    Wrapup --> CreateMR[Create MR]
    CreateMR --> Done[Success]
    HITL --> Done
```

### Two-Phase Design

**Phase 1 (Implement):** Send `/goal "Implement issue #N"` → wait for `goal_complete` signal or context threshold

**Phase 2 (Verify):** Send `/goal "Verify issue #N AC"` → wait for `ac_result` signal

**autoWrapup:** Push branch → create MR → add `stage::qa` label

### Handoff System

When context threshold is reached:
1. **HandoffCoordinator** negotiates summary with agent
2. Persists summary to handoff document
3. Posts summary as issue comment
4. Relaunches session with summary injected
5. Continues until phase completes or budget exhausts

```mermaid
sequenceDiagram
    participant R as WorkflowRunner
    participant HC as HandoffCoordinator
    participant A as Agent
    participant T as TrackerProvider
    participant FS as FileSystem
    participant Sess as SessionStore

    R->>HC: triggerHandoff(context_high)
    HC->>A: requestSummary
    A-->>HC: summary text
    HC->>FS: persist to handoff.md
    HC->>T: postComment(summary)
    HC->>R: handoff doc path
    R->>Sess: save snapshot
    R->>A: resume with summary injected
```

### autoWrapup Key Design

**AC acceptance doesn't rely on Agent self-assessment**. Runner performs objective validation:

1. Push branch to origin
2. `verifyAC()` objective validation:
   - Branch has commits relative to baseBranch (not empty repo)
   - Issue has AC items (labels or markdown)
3. Agent sends `ac_result` signal as **a hint**, not a gate
4. **Runner makes the decision itself**, moving evaluation responsibility from "the evaluated" to "the evaluator"

### AC Data Sources

AC supports two formats, labels first:

```yaml
# Recommended: ac::1::... labels (structured)
labels:
  - ac::1:: User can log in
  - ac::2:: See welcome page

# Compatible: ## AC markdown section (best-effort parsing)
description: |
  ## AC
  - [ ] User can log in
  - [ ] See welcome page
```

### Retry Mechanism

```mermaid
flowchart TD
    AC["verifyAC FAIL"] --> Inc[incrementRetryCount]
    Inc --> Check{retryCount > maxRetries?}
    Check -->|yes| HITL["addLabel mode::hitl, addComment escalating"]
    Check -->|no| Kill[killSession old session]
    Kill --> New[Create new session retry-N]
    New --> Run[Run WorkflowRunner again]
    Run --> AC

    HITL --> End[Return success: false]

    classDef fail fill:#f8d7da,stroke:#dc3545
    classDef success fill:#d4edda,stroke:#28a745
    class AC,Inc fail
    class End success
```

**Key: Each retry is a new session**, not continuing in the same session. This avoids context pollution and aligns with Claude Code's session independence.

---

## Scheduler Design

### Why Scheduler?

`afk implement <iid>` is a single-run command. Scheduler solves:
- **Auto-discovery**: Poll GitLab for Issues with `stage::ready-for-implement`
- **Concurrency control**: Prevent one machine running 10 Agents and blowing up CPU/memory
- **Priority scheduling**: `priority::high` takes precedence over `priority::low`
- **Failure retry**: In-memory queue with exponential backoff

### Scheduling Flow

```mermaid
sequenceDiagram
    participant S as Scheduler
    participant GL as GitLab API
    participant Q as In-Memory Queue
    participant W as Worker
    participant R as WorkflowRunner

    loop Periodic polling
        S->>GL: listIssues(label: ready-for-implement)
        GL-->>S: issues list

        loop Each Issue
            S->>S: checkIssuePreconditions
            S->>Q: getJob(issue-N)
            alt Already queued
                Q-->>S: job exists
                S->>S: skip
            else Not queued
                S->>S: calculatePriority(labels)
                S->>Q: enqueue(issue, priority)
                Q-->>S: jobId
            end
        end
    end

    Q->>W: Dispatch job
    W->>R: runner.run
    R-->>W: success result

    alt Success
        W->>GL: removeLabel(ready-for-implement)
        W->>GL: addLabel(stage::qa)
    else Failure
        W->>Q: Throw error
        Note over Q: Trigger exponential backoff retry
    end
```

### Priority Mapping

| Label | Priority |
|-------|----------|
| `priority::high` | 10 |
| `priority::medium` | 5 |
| `priority::low` | 1 |
| (none) | 5 |

**Deduplication:** `queue.getJob('issue-123')` checks if already queued, avoiding duplicate submissions.

---

## CLI Command System

### Entry Point (`src/index.ts`)

The CLI entry point is a **thin dispatcher** (~50 lines), intentionally minimal to preserve lazy-loading performance:

```mermaid
graph TD
    A["CLI invoked"] --> B{"cmd argument?"}
    B -->|none| TUI["startDashboard (board-entry)"]
    B -->|--version| Ver["Print version"]
    B -->|board| Err["Error: use afk with no args"]
    B -->|other| LL["lazyLoad(cmd, extraArgs)"]
    TUI --> Ink["Ink TUI (React)"]
    LL --> LZ["lazy-loader.ts"]
```

**Design principle:** No shared logging stack at import time. User-facing output lives in commands via `cli-utils` helpers. The entry point only handles version contract and last-resort errors.

### Command Registration (`src/command-registry.ts`)

**Single source of truth.** One `COMMANDS` array feeds both the lazy-loader (fast path) and full-cli (fallback), preventing drift:

```typescript
export const COMMANDS: CommandEntry[] = [
  { names: ['signal'], loader: () => import('./commands/signal.js').then(m => m.registerSignalCommands) },
  { names: ['issue', 'mr'], loader: () => import('./commands/tracker.js').then(m => m.registerTrackerCommands) },
  { names: ['tmux'], loader: () => import('./commands/tmux.js').then(m => m.registerTmuxCommands) },
  { names: ['worktree'], loader: () => import('./commands/worktree.js').then(m => m.registerWorktreeCommands) },
  { names: ['workflow'], loader: () => import('./commands/workflow.js').then(m => m.registerWorkflowCommands) },
  { names: ['scheduler'], loader: () => import('./commands/scheduler.js').then(m => m.registerSchedulerCommands) },
  { names: ['board'], loader: () => import('./commands/board.js').then(m => m.registerBoardCommands) },
  { names: ['kanban'], loader: () => import('./commands/kanban.js').then(m => m.registerKanbanCommands) },
  { names: ['debug'], loader: () => import('./commands/debug.js').then(m => m.registerDebugCommands) },
  { names: ['escalate'], loader: () => import('./commands/escalate.js').then(m => m.registerEscalateCommands) },
  { names: ['isolate'], loader: () => import('./commands/isolate.js').then(m => m.registerIsolateCommands) },
  { names: ['qa'], loader: () => import('./commands/qa.js').then(m => m.registerQACommands) },
  { names: ['loop'], loader: () => import('./commands/loop.js').then(m => m.registerLoopCommands) },
  { names: ['completion', '__complete'], loader: () => import('./commands/completion.js').then(m => m.registerCompletionCommands) },
];
```

### Lazy-Loader (`src/lazy-loader.ts`)

Per-command dynamic import — the fast path:

```mermaid
graph LR
    A["CLI starts ~50ms"] --> B["Command dispatch: index.ts"]
    B --> C{"Command in COMMANDS?"}
    C -->|yes| D["Dynamic import only that command"]
    C -->|no| F["full-cli.ts: load all + parse"]
    D --> E["Parse on matched subcommand"]
    F --> G["Parse full program"]
```

**Why?** Loading all command dependencies slows down lightweight commands like `afk --help`. Lazy-loader reduces cold-start from ~500ms to ~50ms.

### Full-CLI Fallback (`src/full-cli.ts`)

For unknown commands, loads all modules in parallel as fallback:

```mermaid
graph LR
    A["Unknown command"] --> B["runFullCLI()"]
    B --> C["Promise.all(COMMANDS.map loader)"]
    C --> D["Parallel load all modules"]
    D --> E["program.parse()"]
```

### Command Structure

| Command | Register Function | Description |
|---------|-------------------|-------------|
| `afk signal` | `registerSignalCommands` | Structured signal file management |
| `afk issue` / `afk mr` | `registerTrackerCommands` | Issue/MR CRUD, auto-detects platform |
| `afk tmux` | `registerTmuxCommands` | Tmux session management |
| `afk worktree` | `registerWorktreeCommands` | Git worktree list/clean |
| `afk workflow` | `registerWorkflowCommands` | Signal-driven workflow orchestration |
| `afk scheduler` | `registerSchedulerCommands` | In-memory background scheduler |
| `afk board` | `registerBoardCommands` | TUI dashboard |
| `afk kanban` | `registerKanbanCommands` | Kanban board of issues |
| `afk debug` | `registerDebugCommands` | Debug loop (reproduce → verify) |
| `afk escalate` | `registerEscalateCommands` | File issue + launch workflow |
| `afk isolate` | `registerIsolateCommands` | DB service isolation per worktree |
| `afk qa` | `registerQACommands` | QA verification on merged code |
| `afk loop` | `registerLoopCommands` | Continuous integration loop |
| `afk completion` | `registerCompletionCommands` | Shell completion |

**Note:** `github` / `gitlab` legacy command groups are removed. All issue/MR operations go through `afk issue` / `afk mr`.

---

## Lifecycle Modules

Modules extend the WorkflowRunner with additional capabilities:

### Module Registry (`src/lib/modules/_registry.ts`)

```typescript
loadModules(names: string[], params: Record<string, unknown>): LifecycleModule[]
parseModuleParams(params: string[]): Record<string, unknown>
```

### Available Modules

| Module | File | Purpose |
|--------|------|---------|
| **loop-runner** | `modules/loop-runner.ts` | Continuous integration loop |
| **qa-runner** | `modules/qa-runner.ts` | QA verification on merged code |
| **isolate** | `modules/isolate.ts` | DB service isolation per worktree |
| **project-resolver** | `modules/project-resolver.ts` | Cross-project issue resolution |

### Module Loading

```mermaid
graph TD
    CLI[CLI] --> Load[loadModules]
    Load --> Parse[parseModuleParams]
    Parse --> Filter[Filter by names]
    Filter --> Instantiate[Instantiate modules]
    Instantiate --> Attach[Attach to WorkflowRunner]
```

---

## Sandbox Providers

### Provider Architecture

```mermaid
graph TD
    Runner["WorkflowRunner"]
    Factory["createSandboxProvider"]
    Local["LocalSandboxProvider"]
    Container["ContainerSandboxProvider"]

    Runner --> Factory
    Factory -->|local| Local
    Factory -->|container| Container

    Local --> TMUX["TmuxClient"]
    Container --> Docker["Docker/Podman"]

    classDef provider fill:#fff4e1,stroke:#cc6600
    class Factory,Local,Container provider
```

### Local Sandbox

Uses tmux sessions for agent execution:
- Spawns agent in dedicated tmux session
- Shares filesystem with host (worktree)
- Low overhead, fast startup

### Container Sandbox

Uses Docker/Podman for isolation:
- Full process isolation
- Configurable resource limits
- Network isolation option

---

## Session Management

### Session Store Chain

```
FileSessionStore (native Claude Code snapshots)
    ↓ (fallback)
HandoffSessionStore (Markdown handoff documents)
```

### Handoff Flow

```mermaid
sequenceDiagram
    participant Old as Old Session
    participant Sess as SessionStore
    participant FS as FileSystem
    participant New as New Session

    Old->>Sess: saveSnapshot()
    Sess->>FS: write .afk/sessions/{id}.json
    Old->>FS: write handoff.md
    New->>FS: read handoff.md
    New->>New: resume with context
```

---

## Template System

### Template Registry

Templates define workflow execution plans:

```typescript
planFor(name: string, ctx: PlanContext): ExecutionPlan
loadBuiltinTemplates(): Template[]
```

### Built-in Templates

| Template | Purpose |
|----------|---------|
| `implement` | Issue → MR two-phase workflow |
| `qa` | QA verification |
| `loop` | Continuous integration |

### Template Resolution

```mermaid
graph LR
    A[Template name] --> B[Check builtin]
    B -->|found| C[Return builtin]
    B -->|not found| D[Check custom path]
    D -->|found| E[Load custom]
    D -->|not found| F[Error]
```

---

## Tech Stack Selection

| Selection | Alternative | Reason |
|-----------|-------------|--------|
| **TypeScript** | Go/Rust | LLM code generation friendly; mature Node ecosystem |
| **commander** | yargs/oclif | Lightweight, stable API |
| **In-memory queue** | BullMQ (removed) | Lightweight priority queue, no Redis dependency |
| **tmux** | Subprocess management | Process isolation + observability (attach to see output) |
| **git worktree** | Branch switching | Physical isolation, zero switching overhead |
| **Zod** | io-ts/typebox | Friendly error messages, mature ecosystem |
| **Ink** | blessed/ratatui | React-based, componentized TUI |

---

## Extension Points

### Adding a New Platform (Bitbucket Example)

```mermaid
graph LR
    A[Implement TrackerProvider interface] --> B[In client-factory.ts, add detection]
    B --> C[Add TrackerClient factory branch]
    C --> D[No business logic changes needed]

    classDef new fill:#d4edda
    class A,B,C,D new
```

### Adding a New Lifecycle Module

1. Create module in `src/lib/modules/`
2. Export `LifecycleModule` interface implementation
3. Register in `_registry.ts`
4. Activate via `ext` option in `RunnerOptions`

### Adding a New Agent Provider

1. Implement `AgentProvider` interface in `src/lib/agents/`
2. Register in `agents/registry.ts`
3. Activate via `agentProvider` option in `RunnerOptions`

### Adding a New Signal Type

1. Define Zod schema in `SignalSchema`
2. In WorkflowRunner's `waitForAnySignal()` add new type
3. Add corresponding handler method
4. Update Agent skill instructions

### Custom AC Source

AC extraction logic is centralized in `src/lib/core/tracker/ac.ts`. To add a new source (e.g., YAML block, external AC service):

1. Add new extraction function in `extractAC()` by priority
2. Return `{ items, source: 'your-source' }`
3. Callers don't need changes

### Smarter Decisions Using Statusline Data

Statusline JSON provides rich session metadata (token usage, cache hit rate, cost, model, etc.). Beyond context detection, future use cases:

| Decision | Required Field | Threshold Constant |
|----------|---------------|-------------------|
| Trigger early handoff | `cache_read_input_tokens` ratio | TBD |
| Cost alert | `cost.total_cost_usd` | TBD |
| Model switch judgment | `model.display_name` | Config-driven |
| Cache strategy evaluation | `cache_creation_input_tokens` growth rate | TBD |

---

## State Files

| File | Content | Written By | Read By |
|------|---------|------------|---------|
| `.afk/worktrees.json` | Worktree metadata | WorktreeManager | WorktreeManager / CLI |
| `<worktree>/.afk-signal.json` | Control signal | Agent | WorkflowRunner polling |
| `<worktree>/.afk/claude-status.json` | Claude statusline payload | statusline tee (first turn overwrites placeholder) | Runner polling (context threshold detection, prompt-ready detection) |
| `<worktree>/.afk/CRASHED` | Abnormal exit marker | watchdog | WorktreeManager |
| `<worktree>/.afk/SUCCESS` | Success completion marker | workflow end | WorktreeManager |
| `<worktree>/.claude/settings.json` | Auto-injected statusline config | configureStatusline | Claude Code |
| `.afk/sessions/*.json` | Native session snapshots | FileSessionStore | Session chain |
| `handoff.md` | Context handoff document | HandoffCoordinator | New session resume |
| `~/.claude/logs/afk/` | Timeout logs, watchdog records | handleTimeout / watchdog | Ops |

---

## FAQ

### Q: Platform detection fails

Set `TRACKER_PLATFORM=gitlab` or ensure `git remote -v` contains a recognizable domain.

### Q: AC keeps failing

Two scenarios:
1. **AC parsing fails**: Check if issue has `ac::1::...` label or `## AC` markdown section
2. **verifyAC fails**: Branch must have commits relative to baseBranch; empty repos are blocked

### Q: Worktree disk usage

`afk worktree clean --stale` cleans worktrees inactive for 7+ days.

### Q: How to debug a single Issue?

`afk implement <iid> --dry-run` skips execution, only prints the plan.

---

## Related Documents

- [Quick Start](GETTING-STARTED.md) — Installation and configuration
- [Workflows](WORKFLOWS.md) — Complete Issue to MR flow
- [Skills Guide](SKILLS.md) — Claude Code skills
