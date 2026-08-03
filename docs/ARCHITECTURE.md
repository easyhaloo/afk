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
│   ├── signal.ts, tracker.ts, tmux.ts, worktree.ts, workflow.ts
│   ├── scheduler.ts, board.ts, kanban.ts, debug.ts, escalate.ts
│   ├── isolate.ts, qa.ts, loop.ts, completion.ts
│   └── board-entry.ts    # TUI entry point (Ink + React)
├── lib/
│   ├── core/             # Platform clients, IO, git, config, tmux
│   │   ├── config/, git/, github/, gitlab/, io/, tmux/, tracker/
│   ├── agents/           # Agent providers (claude-code, cursor, etc.)
│   ├── branches/         # Branch strategies
│   ├── modules/          # Runner workers (loop-runner, qa-runner)
│   ├── sandbox/          # Docker/Podman sandbox
│   ├── scheduler.ts      # Scheduler logic (in-memory, no Redis)
│   ├── sessions/         # Session store
│   ├── templates/        # Workflow templates
│   └── workflows/        # Workflow execution
├── views/                # TUI views (Ink + React)
│   ├── app/
│   └── board/            # Dashboard, kanban, navigation, registry
└── types/
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
    WT["WorktreeManager (git worktree)"]
    TMUX["TmuxClient Session Management"]
    SIG["Signal I/O (.afk-signal.json)"]
    STATUS["Status I/O (.afk/claude-status.json)"]
    SCONF["Statusline Config Auto-injected into worktree settings"]
    Sched["Scheduler (in-memory)"]
    Queue[("In-Memory Queue")]
    Agent["AI Agent (claude)"]

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
    Runner --> SIG
    Runner --> STATUS
    Runner --> SCONF

    Sched --> Runner
    Sched --> Queue

    Agent -. tmux session .-> TMUX
    Agent -. write signal .-> SIG
    Agent -. stdin JSON per turn .-> STATUS
    SIG -. polling .-> Runner
    STATUS -. on demand .-> Runner

    classDef cli fill:#e1f5ff,stroke:#0066cc
    classDef core fill:#fff4e1,stroke:#cc6600
    classDef io fill:#f0e1ff,stroke:#6600cc

    class CLI,REG,LZ,FULL,Agent cli
    class Runner,Factory,GL,GH,Sched core
    class WT,TMUX,SIG,STATUS,SCONF,Queue,AC io
```

### Module Responsibilities

| Module | Responsibility | Key Design Decision |
|--------|---------------|---------------------|
| **command-registry.ts** | Single source of truth for all CLI commands | One array feeds both lazy-loader and full-cli |
| **lazy-loader.ts** | Per-command dynamic import | Fast path: ~50ms cold start |
| **full-cli.ts** | Load-all fallback for unknown commands | Parallel `Promise.all` load |
| **index.ts** | Thin CLI dispatcher | No shared logging at import time |
| **WorkflowRunner** | Orchestrates complete lifecycle | Signal-driven + statusline objective validation + AC objective verification |
| **AC Extraction** | Extract AC from issue labels / legacy markdown | Label-driven first, markdown as fallback |
| **WorktreeManager** | Independent workspace per Issue | Physical isolation, no branch conflicts |
| **TmuxClient** | Agent runtime environment | Independent sessions, crashes don't affect each other |
| **Signal I/O** | Agent-Runner control communication | Atomic file writes, Zod validation |
| **Status I/O** | Read Claude statusline JSON | Token objective data source |
| **Statusline Config** | Auto-inject worktree settings.json | tee stdin JSON to file + placeholder for startup detection |
| **Scheduler** | Multi-Issue concurrent scheduling | In-memory queue + priority, no Redis dependency |

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

Legacy markdown sections are kept as fallback (best-effort), no migration needed. See `src/lib/core/tracker/ac.ts` for details.

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

### Core State Machine

```mermaid
stateDiagram-v2
    [*] --> Init: run(iid)

    Init: Initialize - getIssue / parseAC
    Worktree: Create Worktree + configure statusline
    TmuxLaunch: Start Tmux Session
    Watchdog: Start Watchdog
    Comment: Post launch comment
    Polling: Wait for signals

    Init --> Worktree
    Worktree --> TmuxLaunch
    TmuxLaunch --> Watchdog
    Watchdog --> Comment
    Comment --> Polling

    Polling --> AutoWrapup: goal_complete
    Polling --> Timeout: timeout
    Polling --> Handoff: token >= threshold

    AutoWrapup: autoWrapup - Objective validation + MR
    Timeout: handleTimeout - Logs + labels
    Handoff: handleHandoff - Context switch

    AutoWrapup --> RetryCheck: verifyAC FAIL
    AutoWrapup --> Success: verifyAC PASS
    RetryCheck --> HITL: retry > max
    RetryCheck --> [*]: Retry new session

    Success --> [*]: MR created
    Timeout --> [*]: Escalate or retry
    Handoff --> Polling: handoff_ready
    HITL --> [*]: Human intervention
```

### Sequence Diagram: Complete Lifecycle

```mermaid
sequenceDiagram
    participant U as User/CLI
    participant W as WorkflowRunner
    participant T as TrackerProvider
    participant G as Git/Worktree
    participant M as TmuxClient
    participant A as AI Agent
    participant Wd as Watchdog

    U->>W: afk implement iid
    W->>T: getIssue(iid)
    T-->>W: TrackedIssue
    W->>T: parseAC(issue) - labels first, fallback markdown

    W->>G: createWorktree(iid, baseBranch)
    G-->>W: Worktree

    W->>W: configureStatusline(write settings.json + placeholder status)

    par Parallel startup
        W->>M: createSession(name, wt.path, claude)
        M->>A: spawn claude process
        W->>Wd: setsid write timeout signal + sleep + kill-session
        Note over Wd: Independent process, triggers even if parent crashes
    end

    M->>W: waitForPrompt - Check placeholder file exists
    W->>M: sendGoal(goalText)
    M->>A: Send /goal + AC

    A->>A: Implement feature + commit
    Note over A: First turn triggers statusline tee, overwrites placeholder with real payload

    loop Signal polling (every 2s)
        W->>A: read .afk-signal.json
        alt goal_complete
            A-->>W: goal_complete signal
            W->>G: pushBranch()
            W->>A: sendResumeWithAC()
            A->>A: Check each AC item
            W->>W: verifyAC(commit count + AC items)
            alt verifyAC OK
                W->>T: createMR(iid, branch, target)
                T-->>W: MR URL
                W->>T: addLabel(stage::qa)
            else verifyAC FAIL
                W->>W: handleACFail
            end
        else timeout (5min)
            Note over W: Soft timeout, continue waiting
        end
    end

    opt Hard timeout (60min)
        Wd->>M: kill-session
        Note over Wd: timeout signal already written
    end
```

### Key Design of autoWrapup

**AC acceptance doesn't rely on Agent self-assessment**. Runner performs objective validation:

1. Push branch to origin
2. `verifyAC()` objective validation:
   - Branch has commits relative to baseBranch (not empty repo)
   - Issue has AC items (labels or markdown)
3. Agent sends `ac_result` signal as **a hint**, not a gate
4. **Runner makes the decision itself**, moving evaluation responsibility from "the evaluated" to "the evaluator"

**Why not trust Agent's PASS/FAIL?**
LLMs tend to "optimistic reporting". Even if Agent writes `result: 'PASS'`, empty repos or issues without AC are still caught by `verifyAC`.

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
    B -->|--version| Ver["Print 0.1.0"]
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
  { names: ['signal'], loader: () => import('./commands/signal.js') },
  { names: ['issue', 'mr'], loader: () => import('./commands/tracker.js') },
  { names: ['tmux'], loader: () => import('./commands/tmux.js') },
  { names: ['worktree'], loader: () => import('./commands/worktree.js') },
  { names: ['workflow'], loader: () => import('./commands/workflow.js') },
  { names: ['scheduler'], loader: () => import('./commands/scheduler.js') },
  { names: ['board'], loader: () => import('./commands/board.js') },
  { names: ['kanban'], loader: () => import('./commands/kanban.js') },
  { names: ['debug'], loader: () => import('./commands/debug.js') },
  { names: ['escalate'], loader: () => import('./commands/escalate.js') },
  { names: ['isolate'], loader: () => import('./commands/isolate.js') },
  { names: ['qa'], loader: () => import('./commands/qa.js') },
  { names: ['loop'], loader: () => import('./commands/loop.js') },
  { names: ['completion', '__complete'], loader: () => import('./commands/completion.js') },
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
    A[Implement TrackerProvider interface] --> B[Add URL recognition in detectProject]
    B --> C[Register branch in createTrackerClient]
    C --> D[Encapsulate platform-specific differences]
    D --> E[No business logic changes needed]

    classDef new fill:#d4edda
    class A,B,C,D,E new
```

**No changes needed:** WorkflowRunner, business commands, Scheduler

### Adding a New Signal Type

1. Define Zod schema in `SignalSchema`
2. Add new type in WorkflowRunner's `waitForAnySignal()`
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

Extension: Add aggregated fields in `extractTokenUsage()` in `src/lib/core/io/status.ts`; add thresholds in `constants.ts`; read as needed in WorkflowRunner.

### Custom Workflow Hooks

RunnerOptions supports hooks like `customValidation`, allowing custom logic (lint, performance tests, screenshot verification) before/after AC checks.

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
- [Skills Guide](SKILLS.md) — 8 Claude Code skills
