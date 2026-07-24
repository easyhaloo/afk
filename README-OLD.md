# afk - Unified CLI for AFK Workflow

Single entry point for all AFK (Automated Feature Kitchen) operations.

**Production-grade workflow automation with TypeScript, Zod validation, and BullMQ scheduler.**

## Quick Installation

### One-Click Install (Recommended)

```bash
# Clone repository
git clone https://github.com/your-org/afk-cli.git
cd afk-cli

# Run installer (installs to /usr/local/bin)
./install.sh

# Or install to /usr/bin (requires sudo)
sudo ./install.sh --system

# Or install to custom location
./install.sh --prefix ~/.local/bin
```

The installer will:
- ✅ Check dependencies (Node.js v18+, npm, git)
- ✅ Install npm packages
- ✅ Build TypeScript
- ✅ Create executable wrapper in /usr/local/bin
- ✅ Verify installation

### Manual Installation

```bash
# Clone and build
git clone https://github.com/your-org/afk-cli.git
cd afk-cli
npm install
npm run build

# Link globally
npm link
```

### Verify Installation

```bash
afk --version
# Output: 0.1.0

afk --help
# Shows all 6 modules
```

### Uninstall

```bash
# Interactive uninstall
./uninstall.sh

# Force uninstall (no confirmation)
./uninstall.sh --force

# Remove everything including config
./uninstall.sh --force --remove-config
```

## Usage

```bash
afk <command> <subcommand> [options]
```

## Commands

### Signal Management

Structured signal files for agent-scheduler communication.

```bash
# Create signals
afk signal goal-complete --summary "Feature implemented"
afk signal ac-result --result PASS --summary "All tests passed" --tests-run 12 --tests-passed 12
afk signal handoff-ready --summary "Context limit reached"

# Read signal
afk signal read
afk signal read --json

# Wait for signal
afk signal wait --type goal_complete --timeout 300000

# Clear signal
afk signal clear
```

### GitLab Operations

Type-safe GitLab API operations with built-in retry.

```bash
# Get issue
afk gitlab get-issue 123
afk gitlab get-issue 123 --json

# List issues
afk gitlab list-issues
afk gitlab list-issues --label "stage::ready-for-implement" --state opened
afk gitlab list-issues --json

# Manage labels
afk gitlab add-label 123 "stage::in-progress"
afk gitlab remove-label 123 "stage::ready-for-implement"

# Add comment
afk gitlab add-comment 123 "Starting implementation"

# Parse acceptance criteria
afk gitlab parse-ac 123
afk gitlab parse-ac 123 --json
```

### Tmux Session Management

Intelligent tmux operations for Claude agent sessions.

```bash
# Create session
afk tmux create-session --name afk-123 --dir /tmp/worktree --command claude

# Send /goal command
afk tmux send-goal --session afk-123 --text "Implement login feature"

# Wait for prompt
afk tmux wait-for-prompt --session afk-123 --timeout 30000

# Capture pane content
afk tmux capture --session afk-123 --lines 50

# Wait for signal (polls signal file + pane output)
afk tmux wait-signal --session afk-123 --type goal_complete --dir /tmp/worktree

# Kill session
afk tmux kill-session afk-123

# Check if session exists
afk tmux has-session afk-123
```

### Worktree Management

Git worktree operations with state tracking and orphan detection.

```bash
# Create worktree
afk worktree create --iid 123 --branch main --base-dir /tmp/afk-worktrees

# Get worktree info
afk worktree get 123
afk worktree get 123 --json

# List all worktrees
afk worktree list
afk worktree list --json

# Cleanup worktree
afk worktree cleanup 123
afk worktree cleanup 123 --force  # Force cleanup even with uncommitted changes

# List orphaned worktrees (no matching tmux session)
afk worktree list-orphaned

# Prune all orphaned worktrees
afk worktree prune
afk worktree prune --dry-run  # Show what would be removed

# Update worktree status
afk worktree update-status 123 completed
```

### Workflow Orchestration

High-level workflow commands that orchestrate multiple operations.

```bash
# Launch complete workflow (one command!)
afk workflow launch --iid 123 --branch main
# → Creates worktree, starts session, sends goal, waits for completion

# Run AC checks
afk workflow run-ac --iid 123 --session afk-123 --dir /tmp/worktree

# Create merge request
afk workflow create-mr --iid 123 --dir /tmp/worktree --target-branch main

# Check workflow status
afk workflow status --iid 123
```

### Scheduler (Event-Driven)

Task queue management with BullMQ + Redis.

```bash
# Start scheduler daemon
afk scheduler start --max-concurrent 5 --poll-interval 60
# → Polls GitLab every 60s, processes up to 5 tasks concurrently

# Check scheduler status
afk scheduler status

# Manually enqueue task
afk scheduler enqueue --iid 123 --priority 10

# Pause/resume tasks
afk scheduler pause --iid 123
afk scheduler resume --iid 123

# Manually poll GitLab
afk scheduler poll
```

## Configuration

Set environment variables:

```bash
export GITLAB_URL="https://gitlab.com"
export GITLAB_TOKEN="glpat-xxxxx"
export GITLAB_PROJECT_ID="12345"
```

Or create `~/.config/afk/config.json` (future):

```json
{
  "gitlab": {
    "url": "https://gitlab.com",
    "token": "$GITLAB_TOKEN",
    "projectId": "12345"
  }
}
```

## Architecture

```
afk/
├── src/
│   ├── index.ts           # CLI entry point
│   ├── commands/          # Command modules
│   │   ├── signal.ts      # Signal commands
│   │   ├── gitlab.ts      # GitLab commands
│   │   ├── tmux.ts        # (planned)
│   │   ├── worktree.ts    # (planned)
│   │   ├── workflow.ts    # (planned)
│   │   └── scheduler.ts   # (planned)
│   └── lib/               # Core libraries
│       ├── schemas.ts     # Signal schemas (Zod)
│       ├── io.ts          # Signal I/O
│       └── gitlab.ts      # GitLab client
```

## Benefits Over Bash

| Feature | Bash Scripts | Unified CLI |
|---------|-------------|-------------|
| **Type Safety** | None | Full (Zod + TS) |
| **Entry Point** | Multiple scripts | Single `afk` command |
| **Help System** | Manual docs | Auto-generated (`--help`) |
| **Error Handling** | Exit codes | Typed errors |
| **Testing** | 0% | 80%+ (planned) |
| **Maintainability** | 3/10 | 9/10 |

## Integration with Bash

Bash scripts can call `afk` commands:

```bash
# Old way
issue_json=$(glab_safe issue view "$iid" --json)

# New way
issue_json=$(afk gitlab get-issue "$iid" --json)
```

Gradual migration strategy:
1. `afk` works alongside existing Bash
2. Bash functions become wrappers around `afk`
3. Eventually deprecate Bash implementations

## Development

```bash
npm run dev      # Watch mode
npm run build    # Build
npm test         # Run tests (planned)
```

## Roadmap

### Phase 1: Core (✅ Complete)
- [x] Signal management
- [x] GitLab operations

### Phase 2: Session Management (✅ Complete)
- [x] Tmux commands
- [x] Worktree commands

### Phase 3: Workflows (✅ Complete)
- [x] High-level workflow commands
- [x] AC runner
- [x] MR creator

### Phase 4: Scheduler (✅ Complete)
- [x] Event-driven scheduler (BullMQ)
- [x] Queue management
- [x] GitLab polling
- [ ] Web UI (future enhancement)

## Examples

### End-to-End Workflow

**Current (Bash):**
```bash
./scripts/scheduler.sh &          # Start scheduler
./scripts/claude-agent.sh launch 123  # Launch agent
```

**With Unified CLI:**
```bash
# Create worktree
wt=$(afk worktree create --iid 123 --branch main --json | jq -r .path)

# Create tmux session
afk tmux create-session --name afk-123 --dir "$wt"

# Send goal
goal_text=$(afk gitlab parse-ac 123 --json | jq -r '.items | join("\n")')
afk tmux send-goal --session afk-123 --text "$goal_text"

# Wait for completion
afk tmux wait-signal --session afk-123 --type goal_complete --dir "$wt"

# Cleanup
afk worktree cleanup 123
afk tmux kill-session afk-123
```

**Future (Phase 3 - High-level workflow):**
```bash
afk workflow launch --iid 123  # One command does everything!
```

### Signal Flow

**Agent creates signal:**
```bash
# In tmux session, agent runs:
afk signal goal-complete --summary "Login feature implemented"
```

**Scheduler detects signal:**
```bash
# Polling in scheduler
signal=$(afk signal wait --type goal_complete --timeout 300)
echo "Goal completed: $(echo $signal | jq -r .summary)"
```

## License

Internal tool for AFK workflow.
