# AFK CLI Quick Start Guide

## Prerequisites

1. **Node.js**: v18+ required
2. **Redis**: Required for scheduler
3. **GitLab**: Access token with API permissions
4. **Tmux**: v3.0+ recommended

## Installation

```bash
cd ~/.claude/skills/afk-implement/cli/afk
npm install
npm run build
npm link  # Makes 'afk' globally available
```

Verify installation:
```bash
afk --version
# Output: 0.1.0

afk --help
# Shows all 6 modules
```

## Configuration

Create environment file:
```bash
cat > ~/.config/afk/.env <<'EOF'
GITLAB_TOKEN=glpat-xxxxxxxxxxxxx
GITLAB_PROJECT_ID=12345
GITLAB_BASE_URL=https://gitlab.company.com/api/v4

REDIS_HOST=localhost
REDIS_PORT=6379

AFK_WORKTREE_DIR=/tmp/afk-worktrees
AFK_MAX_CONCURRENT=3
EOF
```

Export variables:
```bash
source ~/.config/afk/.env
```

## 5-Minute Tutorial

### 1. Signal Management (Basics)

Create a completion signal:
```bash
cd /tmp/test-worktree
afk signal goal-complete --summary "Feature implementation complete" --sha abc123
```

Read the signal:
```bash
afk signal read
# Output (JSON):
# {
#   "type": "goal_complete",
#   "timestamp": "2026-07-25T01:15:00Z",
#   "sha": "abc123",
#   "summary": "Feature implementation complete"
# }
```

Wait for signal (with timeout):
```bash
afk signal wait --type goal_complete --timeout 60
# Polls every 5s, returns when signal appears
```

### 2. GitLab Operations

Get issue details:
```bash
afk gitlab get-issue --iid 123
# Output:
# Issue #123: Add user authentication
# Labels: stage::ready-for-implement, priority::high
# AC Items: 3
```

List ready issues:
```bash
afk gitlab list-issues --label "stage::ready-for-implement"
# Output:
# #123: Add user authentication (high)
# #124: Fix login bug (medium)
# #125: Update docs (low)
```

Parse acceptance criteria:
```bash
afk gitlab parse-ac --iid 123
# Output (JSON):
# {
#   "text": "...",
#   "items": [
#     "Login with email/password works",
#     "Session persists across page reload",
#     "Logout clears session"
#   ]
# }
```

### 3. Tmux Session Management

Create Claude session:
```bash
afk tmux create-session --name claude-123 --directory /tmp/afk-worktrees/issue-123
# Creates tmux session with proper environment
```

Send goal to Claude:
```bash
afk tmux send-goal --session claude-123 --window main --goal "Implement the following:
1. Login with email/password
2. Session persistence
3. Logout functionality"
# Sends goal via /goal command
```

Wait for completion:
```bash
afk tmux wait-for-signal --session claude-123 --window main --type goal_complete --worktree /tmp/afk-worktrees/issue-123 --timeout 3600
# Polls until signal appears or timeout
```

### 4. Worktree Management

Create worktree for issue:
```bash
afk worktree create --iid 123 --base main
# Output:
# Created worktree at /tmp/afk-worktrees/issue-123
# Branch: afk-issue-123
# Status: active
```

List all worktrees:
```bash
afk worktree list
# Output:
# #123: /tmp/afk-worktrees/issue-123 (afk-issue-123) - active
# #124: /tmp/afk-worktrees/issue-124 (afk-issue-124) - active
```

Cleanup completed worktree:
```bash
afk worktree cleanup --iid 123
# Checks for uncommitted changes, removes if clean
```

Detect orphans (no matching tmux session):
```bash
afk worktree list-orphaned
# Output:
# Orphaned worktrees (no active tmux session):
# #125: /tmp/afk-worktrees/issue-125 (afk-issue-125)
```

### 5. Workflow Orchestration (One Command!)

Launch complete workflow:
```bash
afk workflow launch --iid 123 --base main --timeout 7200
# Does everything:
# 1. Creates worktree
# 2. Creates tmux session
# 3. Sends goal to Claude
# 4. Waits for completion
# 5. Returns result
```

Run acceptance criteria checks:
```bash
afk workflow run-ac --iid 123 --session claude-123 --worktree /tmp/afk-worktrees/issue-123
# Sends AC items to Claude for verification
# Output:
# AC Result: PASS
# All 3 criteria satisfied
```

Create merge request:
```bash
afk workflow create-mr --iid 123 --worktree /tmp/afk-worktrees/issue-123
# Pushes branch and creates MR via GitLab API
# Output:
# MR created: !456 (afk-issue-123 -> main)
# URL: https://gitlab.company.com/project/-/merge_requests/456
```

Get workflow status:
```bash
afk workflow status --iid 123
# Shows complete state of issue workflow
```

### 6. Event-Driven Scheduler (Production!)

Start scheduler daemon:
```bash
afk scheduler start --max-concurrent 3 --poll-interval 60
# Runs in foreground (use tmux/screen for background)
# Polls GitLab every 60s for ready issues
# Processes up to 3 issues concurrently
```

Enqueue issue manually:
```bash
afk scheduler enqueue --iid 123 --priority 10
# Adds issue to queue immediately
# Priority: 10 (high), 5 (medium), 1 (low)
```

Check scheduler status:
```bash
afk scheduler status
# Output:
# Scheduler Status
# ================
# Active: true
# Queue: 5 waiting, 2 active, 15 completed
# Workers: 2/3 busy
# 
# Recent completions:
# #120: Success (MR !450 created)
# #121: Failed (AC check failed)
```

Poll GitLab for new issues:
```bash
afk scheduler poll
# Manual poll trigger (happens automatically in daemon mode)
# Finds issues with "stage::ready-for-implement" label
# Enqueues with priority based on labels
```

Pause scheduler:
```bash
afk scheduler pause
# Pauses processing (completes active tasks, no new starts)
```

Resume scheduler:
```bash
afk scheduler resume
# Resumes processing from queue
```

## Common Workflows

### Manual Single Issue

```bash
# 1. Launch workflow
afk workflow launch --iid 123

# 2. Wait for Claude to complete (or monitor tmux session)

# 3. Run AC checks
afk workflow run-ac --iid 123 --session claude-123 --worktree /tmp/afk-worktrees/issue-123

# 4. Create MR if passed
afk workflow create-mr --iid 123 --worktree /tmp/afk-worktrees/issue-123

# 5. Cleanup
afk worktree cleanup --iid 123
```

### Automated Batch Processing

```bash
# Start scheduler in tmux session
tmux new-session -d -s afk-scheduler \
  "afk scheduler start --max-concurrent 5 --poll-interval 60"

# Monitor logs
tmux attach -t afk-scheduler

# Or check status remotely
afk scheduler status
```

### Emergency Recovery

```bash
# List all orphaned worktrees
afk worktree list-orphaned

# Cleanup orphans (interactive confirmation)
afk worktree prune

# Or force cleanup specific worktree
afk worktree cleanup --iid 123 --force
```

## Troubleshooting

### CLI Not Found
```bash
# Re-link the CLI
cd ~/.claude/skills/afk-implement/cli/afk
npm link

# Or use absolute path
node ~/.claude/skills/afk-implement/cli/afk/dist/index.js --help
```

### Redis Connection Error
```bash
# Start Redis (macOS)
brew services start redis

# Or Docker
docker run -d -p 6379:6379 redis:7-alpine

# Verify connection
redis-cli ping
# Should output: PONG
```

### GitLab API Error
```bash
# Test token manually
curl -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "$GITLAB_BASE_URL/projects/$GITLAB_PROJECT_ID"

# Should return project details (not 401/404)
```

### Tmux Session Not Found
```bash
# List all tmux sessions
tmux ls

# Attach to session manually
tmux attach -t claude-123

# Or kill stale session
tmux kill-session -t claude-123
```

### Signal Not Detected
```bash
# Check if signal file exists
ls -la /tmp/afk-worktrees/issue-123/.afk-signal.json

# Read signal manually
cat /tmp/afk-worktrees/issue-123/.afk-signal.json | jq .

# Clear stale signal
afk signal clear --directory /tmp/afk-worktrees/issue-123
```

## Advanced Usage

### Custom Timeout
```bash
# Short timeout (5 minutes)
afk workflow launch --iid 123 --timeout 300

# Long timeout (4 hours)
afk workflow launch --iid 123 --timeout 14400
```

### Priority Override
```bash
# Force high priority
afk scheduler enqueue --iid 123 --priority 10

# Low priority (background task)
afk scheduler enqueue --iid 123 --priority 1
```

### JSON Output (for scripting)
```bash
# Get JSON output
afk gitlab get-issue --iid 123 --json | jq .

# Parse in script
issue_title=$(afk gitlab get-issue --iid 123 --json | jq -r '.title')
echo "Working on: $issue_title"
```

### Watch Mode
```bash
# Poll signal file continuously
afk signal wait --type goal_complete --timeout 3600 --interval 10
# Checks every 10 seconds (default: 5)
```

## Production Deployment

### Systemd Service (Linux)

```ini
# /etc/systemd/system/afk-scheduler.service
[Unit]
Description=AFK Scheduler
After=network.target redis.service

[Service]
Type=simple
User=afk
WorkingDirectory=/home/afk
Environment="GITLAB_TOKEN=glpat-xxx"
Environment="GITLAB_PROJECT_ID=12345"
Environment="REDIS_HOST=localhost"
ExecStart=/usr/local/bin/afk scheduler start --max-concurrent 5
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable afk-scheduler
sudo systemctl start afk-scheduler
sudo systemctl status afk-scheduler
```

### Docker Compose

```yaml
# docker-compose.yml
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
  
  afk-scheduler:
    build: ./afk-implement/cli/afk
    environment:
      GITLAB_TOKEN: glpat-xxx
      GITLAB_PROJECT_ID: 12345
      REDIS_HOST: redis
      AFK_MAX_CONCURRENT: 5
    depends_on:
      - redis
    command: afk scheduler start --poll-interval 60
```

### Monitoring

Add Prometheus metrics export (future enhancement):
```bash
# Start with metrics endpoint
afk scheduler start --metrics-port 9090

# Scrape metrics
curl http://localhost:9090/metrics
```

## Next Steps

- Read [FINAL-IMPLEMENTATION-SUMMARY.md](./FINAL-IMPLEMENTATION-SUMMARY.md) for architecture details
- Check [README.md](../cli/afk/README.md) for API documentation
- See [CLI-MODERNIZATION-ANALYSIS.md](./CLI-MODERNIZATION-ANALYSIS.md) for design decisions

## Need Help?

```bash
# Every command has --help
afk --help
afk signal --help
afk workflow launch --help

# Check version
afk --version

# Report issues
# GitHub: https://github.com/your-org/afk/issues
```

---

**You're ready to use the AFK CLI! 🚀**

Start with `afk workflow launch --iid <your-issue-number>` for your first automated workflow.
