# Unified AFK CLI Architecture

## Design Philosophy

**Single entry point, multiple subcommands** - 类似 `git`、`docker`、`kubectl`

```bash
afk <command> <subcommand> [options]

# Examples:
afk signal goal-complete --summary "..."
afk gitlab get-issue 123
afk tmux send-goal --session afk --text "..."
afk worktree create --iid 123
afk workflow run-ac --iid 123
afk scheduler start
```

## Architecture

```
afk (root CLI)
├── signal/          # Signal management (已实现)
│   ├── goal-complete
│   ├── ac-result
│   ├── handoff-ready
│   ├── read
│   ├── wait
│   └── clear
│
├── gitlab/          # GitLab operations
│   ├── get-issue <iid>
│   ├── list-issues [--label] [--state]
│   ├── update-label <iid> <label>
│   ├── create-mr <iid> [--target-branch]
│   ├── add-comment <iid> <message>
│   └── parse-ac <iid>
│
├── tmux/            # Tmux session management
│   ├── create-session <name>
│   ├── send-goal --session <name> --text <goal>
│   ├── wait-for-prompt --session <name>
│   ├── capture --session <name> [--lines]
│   ├── wait-signal --session <name> --type <type>
│   └── kill-session <name>
│
├── worktree/        # Git worktree management
│   ├── create --iid <iid> --branch <branch>
│   ├── cleanup --iid <iid>
│   ├── list
│   ├── list-orphaned
│   └── prune
│
├── workflow/        # High-level workflows
│   ├── launch --iid <iid>
│   ├── run-ac --iid <iid> --session <name>
│   ├── create-mr --iid <iid>
│   ├── handoff --iid <iid> --reason <reason>
│   └── status --iid <iid>
│
├── scheduler/       # Task scheduling
│   ├── start [--max-concurrent]
│   ├── stop
│   ├── status
│   ├── pause --iid <iid>
│   ├── resume --iid <iid>
│   └── logs [--follow]
│
└── config/          # Configuration management
    ├── get <key>
    ├── set <key> <value>
    ├── list
    └── validate
```

## Technology Stack

### Core Framework
- **TypeScript** - Type safety across all modules
- **Commander.js** - CLI framework with subcommand support
- **Zod** - Runtime validation for all inputs/outputs

### Module-specific
- **GitLab**: `@gitbeaker/node` - Official GitLab SDK
- **Tmux**: Custom Node.js wrapper around tmux control mode
- **Git**: `simple-git` - Git operations
- **Scheduler**: `bullmq` + `ioredis` - Queue management
- **Config**: `conf` - JSON config with schema validation

## Project Structure

```
cli/afk/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # Root CLI entry point
│   ├── commands/
│   │   ├── signal.ts         # Signal subcommands
│   │   ├── gitlab.ts         # GitLab subcommands
│   │   ├── tmux.ts           # Tmux subcommands
│   │   ├── worktree.ts       # Worktree subcommands
│   │   ├── workflow.ts       # Workflow subcommands
│   │   ├── scheduler.ts      # Scheduler subcommands
│   │   └── config.ts         # Config subcommands
│   │
│   ├── lib/
│   │   ├── signal/           # Signal logic (from afk-signal)
│   │   │   ├── schemas.ts
│   │   │   └── io.ts
│   │   │
│   │   ├── gitlab/
│   │   │   ├── client.ts     # GitLab API client wrapper
│   │   │   ├── issue.ts      # Issue operations
│   │   │   ├── mr.ts         # MR operations
│   │   │   └── parser.ts     # AC/metadata parsing
│   │   │
│   │   ├── tmux/
│   │   │   ├── client.ts     # Tmux control mode wrapper
│   │   │   ├── session.ts    # Session management
│   │   │   └── capture.ts    # Pane capture utilities
│   │   │
│   │   ├── worktree/
│   │   │   ├── manager.ts    # Worktree CRUD
│   │   │   ├── state.ts      # State tracking
│   │   │   └── cleanup.ts    # Orphan detection
│   │   │
│   │   ├── workflow/
│   │   │   ├── launcher.ts   # Issue → session pipeline
│   │   │   ├── ac-runner.ts  # AC check orchestration
│   │   │   ├── mr-creator.ts # MR creation logic
│   │   │   └── handoff.ts    # Context handoff
│   │   │
│   │   └── scheduler/
│   │       ├── queue.ts      # BullMQ queue wrapper
│   │       ├── worker.ts     # Task processor
│   │       ├── webhook.ts    # GitLab webhook handler
│   │       └── monitor.ts    # Status monitoring
│   │
│   ├── types/
│   │   ├── issue.ts          # Issue types
│   │   ├── signal.ts         # Signal types
│   │   ├── session.ts        # Session types
│   │   └── config.ts         # Config types
│   │
│   └── utils/
│       ├── logger.ts         # Structured logging
│       ├── errors.ts         # Error types
│       └── validation.ts     # Common validators
│
└── tests/
    ├── signal.test.ts
    ├── gitlab.test.ts
    └── ...
```

## Implementation Plan

### Phase 1: Core Infrastructure (Week 1)
**Goal: Unified CLI skeleton + Signal + GitLab**

1. **Setup unified CLI project**
   ```bash
   mkdir cli/afk
   npm init -y
   npm install commander zod chalk @gitbeaker/node
   npm install -D typescript @types/node vitest
   ```

2. **Migrate afk-signal into unified CLI**
   - Move `afk-signal/src/*` → `cli/afk/src/lib/signal/`
   - Create `src/commands/signal.ts` that wraps signal lib
   - Test: `afk signal goal-complete --summary "test"`

3. **Implement GitLab module**
   - `lib/gitlab/client.ts` - Wrapper with retry/cache
   - `lib/gitlab/issue.ts` - Issue operations
   - `lib/gitlab/parser.ts` - Extract AC from description
   - Test: `afk gitlab get-issue 123`

4. **Replace Bash gitlab-safe.sh**
   - Update `claude-agent.sh` to call `afk gitlab` commands
   - Keep bash functions as wrappers (deprecation period)

### Phase 2: Session Management (Week 2)
**Goal: Tmux + Worktree modules**

5. **Implement Tmux module**
   - `lib/tmux/client.ts` - Tmux control mode
   - `lib/tmux/session.ts` - Smart send/wait operations
   - Test: `afk tmux send-goal --session test --text "..."`

6. **Implement Worktree module**
   - `lib/worktree/manager.ts` - Create/cleanup with state
   - `lib/worktree/state.ts` - Track active worktrees
   - Test: `afk worktree create --iid 123`

7. **Replace Bash tmux/worktree logic**
   - Update `claude-agent.sh` to use `afk tmux` and `afk worktree`

### Phase 3: Workflow Orchestration (Week 3)
**Goal: High-level workflow commands**

8. **Implement Workflow module**
   - `lib/workflow/launcher.ts` - `afk workflow launch --iid 123`
   - `lib/workflow/ac-runner.ts` - `afk workflow run-ac --iid 123`
   - `lib/workflow/mr-creator.ts` - `afk workflow create-mr --iid 123`

9. **Replace Bash workflow.sh**
   - Bash scripts now call `afk workflow` commands
   - Keep minimal bash orchestration layer

### Phase 4: Scheduler (Week 4)
**Goal: Event-driven scheduler with queue**

10. **Implement Scheduler module**
    - `lib/scheduler/queue.ts` - BullMQ wrapper
    - `lib/scheduler/worker.ts` - Process tasks
    - `lib/scheduler/webhook.ts` - GitLab event listener
    - Test: `afk scheduler start --max-concurrent 3`

11. **Replace Bash scheduler.sh**
    - Fully deprecate bash scheduler
    - New: `afk scheduler start` as daemon

### Phase 5: Polish & Documentation (Week 5)
**Goal: Production-ready CLI**

12. **Add comprehensive tests**
    - Unit tests for all modules (80%+ coverage)
    - Integration tests for workflows

13. **Add Web UI (optional)**
    - Express server with REST API
    - React dashboard for monitoring
    - Accessible via `afk scheduler ui`

14. **Documentation**
    - CLI reference docs (generated from Commander)
    - Migration guide from Bash
    - Architecture diagrams

## Usage Examples

### Agent Workflow (simplified)

**Before (Bash + multiple tools):**
```bash
# In claude-agent.sh
wt=$(git worktree add ...)
trap "git worktree remove '$wt'" EXIT

tmux new-window -t "$session" -n "$window" "cd '$wt' && claude"
tmux send-keys -t "${session}:${window}" "/goal ..." C-m

# Wait for completion (manual polling)
while true; do
  pane=$(tmux capture-pane -t "${session}:${window}" -p | tail -20)
  if [[ "$pane" == *"GOAL_COMPLETE"* ]]; then
    break
  fi
  sleep 15
done

# Run AC checks
source _lib/workflow.sh
auto_wrapup "$iid" "$wt" "$session" "$window"
```

**After (Unified CLI):**
```bash
# Option 1: High-level workflow command (recommended)
afk workflow launch --iid 123
# ↑ Handles everything: worktree, tmux, goal injection, wait, AC, MR

# Option 2: Fine-grained control
wt=$(afk worktree create --iid 123 --branch main)
session=$(afk tmux create-session --name "afk-123" --dir "$wt")

afk tmux send-goal --session "$session" --text "$(afk gitlab parse-ac 123)"
afk tmux wait-signal --session "$session" --type goal_complete --timeout 7200

afk workflow run-ac --iid 123 --session "$session"
afk workflow create-mr --iid 123

afk worktree cleanup --iid 123
```

### Scheduler Usage

**Before (Bash):**
```bash
# scheduler.sh - manual polling loop
while true; do
  ready_issues=$(glab issue list --label "stage::ready-for-implement" ...)
  for iid in $ready_issues; do
    if can_start_session; then
      ./claude-agent.sh launch "$iid" &
    fi
  done
  sleep 60
done
```

**After (Event-driven):**
```bash
# Start scheduler daemon (listens to GitLab webhooks)
afk scheduler start --max-concurrent 5

# Monitor in real-time
afk scheduler logs --follow

# Check status
afk scheduler status
# Output:
# Queue: 3 waiting, 5 active, 12 completed
# Workers: 5/5 busy
# Uptime: 2h 34m
```

## Configuration

### Config file: `~/.config/afk/config.json`

```json
{
  "gitlab": {
    "url": "https://gitlab.com",
    "token": "$GITLAB_TOKEN",
    "projectId": "12345"
  },
  "tmux": {
    "sessionPrefix": "afk",
    "historyLimit": 10000
  },
  "scheduler": {
    "maxConcurrent": 3,
    "queueName": "afk-tasks",
    "redis": {
      "host": "localhost",
      "port": 6379
    }
  },
  "worktree": {
    "baseDir": "/tmp/afk-worktrees",
    "cleanupAge": 86400
  },
  "workflow": {
    "completionTimeout": 7200,
    "maxRetries": 3,
    "targetBranch": "main"
  }
}
```

### CLI config commands:
```bash
afk config set gitlab.token "glpat-xxx"
afk config set scheduler.maxConcurrent 5
afk config get gitlab.projectId
afk config list
afk config validate
```

## Migration Strategy

### Stage 1: Parallel Operation (Month 1)
- New `afk` CLI deployed alongside Bash scripts
- Bash scripts have fallback: try `afk` first, fallback to bash
- Example:
  ```bash
  if command -v afk >/dev/null 2>&1; then
    issue_json=$(afk gitlab get-issue "$iid")
  else
    issue_json=$(glab_safe issue view "$iid" --json)
  fi
  ```

### Stage 2: Deprecation Warnings (Month 2)
- Bash functions print deprecation warnings
- Metrics track CLI vs Bash usage
- Documentation updated to show CLI examples

### Stage 3: Full Migration (Month 3)
- Bash scripts become thin wrappers around `afk` CLI
- Example:
  ```bash
  # claude-agent.sh
  #!/usr/bin/env bash
  exec afk workflow launch "$@"
  ```

### Stage 4: Cleanup (Month 4)
- Remove deprecated Bash functions
- Keep only entry point scripts for backward compat

## Benefits of Unified CLI

### Developer Experience
- ✅ **Single installation**: `npm install -g afk`
- ✅ **Consistent interface**: Same patterns across all commands
- ✅ **Auto-completion**: Shell completion for all subcommands
- ✅ **Help system**: `afk --help`, `afk gitlab --help`
- ✅ **Version management**: `afk --version`

### Code Quality
- ✅ **Type safety**: End-to-end TypeScript
- ✅ **Shared utilities**: Logging, error handling, validation
- ✅ **Testability**: Mock GitLab/Tmux in unit tests
- ✅ **Maintainability**: Single repo, consistent patterns

### Operations
- ✅ **Observability**: Structured logging, metrics export
- ✅ **Configuration**: Centralized config with validation
- ✅ **Extensibility**: Plugin system for custom commands
- ✅ **Distribution**: npm package or standalone binary

### Performance
- ✅ **Startup time**: ~50ms (vs ~200ms for bash + sourcing)
- ✅ **Caching**: GitLab responses cached (Redis/file)
- ✅ **Parallelism**: Async operations (Promise.all)
- ✅ **Connection pooling**: Reuse GitLab/Redis connections

## Comparison

| Aspect | Bash Scripts | Unified CLI |
|--------|--------------|-------------|
| **Lines of code** | ~2000 | ~1500 (estimated) |
| **Languages** | Bash, jq, glab | TypeScript only |
| **Type safety** | None | Full (Zod + TS) |
| **Tests** | 0% | 80%+ |
| **Error handling** | Exit codes | Typed errors |
| **Performance** | ~200ms startup | ~50ms startup |
| **Maintainability** | 3/10 | 9/10 |
| **Distribution** | Git clone + PATH | `npm install -g afk` |
| **Documentation** | Scattered | Auto-generated |
| **Debugging** | Echo + stderr | Structured logs |

## Next Steps

1. **Prototype validation** (2-3 days)
   - Create unified CLI skeleton
   - Migrate afk-signal into it
   - Add gitlab module
   - Test end-to-end: `afk signal` + `afk gitlab`

2. **Decision point**
   - If prototype succeeds → proceed with Phase 1
   - Gather feedback on CLI UX
   - Adjust architecture if needed

3. **Incremental rollout**
   - Start with Phase 1 (Signal + GitLab)
   - Deploy in parallel with Bash
   - Measure adoption and stability
