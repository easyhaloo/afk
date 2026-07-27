# AFK 工作流程

## 概述

AFK 实现三种主要工作流模式：
1. **Issue → 实现 → MR 流水线**：手动或自动化 issue 处理
2. **调度器工作流**：后台依赖感知执行
3. **Skills 工作流**：TDD 方法论集成

## Issue → Implementation → MR Pipeline

End-to-end workflow from issue discovery to merge request.

### Manual Execution

```bash
# 1. Discover ready issues
afk issue list --label "stage::ready-for-implement"

# 2. Launch workflow for specific issue
afk workflow launch --iid 123 --base main --timeout 7200

# 3. Monitor progress (workflow runs in tmux session)
tmux attach -t afk-issue-123

# 4. Run acceptance criteria checks
afk workflow run-ac --iid 123 --session afk-issue-123 --worktree /tmp/afk-worktrees/issue-123

# 5. Create merge request if passed
afk workflow create-mr --iid 123 --worktree /tmp/afk-worktrees/issue-123

# 6. Cleanup worktree
afk worktree cleanup --iid 123
```

### Automated Execution (Scheduler)

```bash
# Start scheduler daemon
afk scheduler start --max-concurrent 3 --poll-interval 60

# Scheduler automatically:
# 1. Polls for issues with stage::ready-for-implement
# 2. Validates preconditions (AC, base label, no blockers)
# 3. Launches workflows up to max-concurrent limit
# 4. Monitors completion and creates MRs
```

### Workflow Stages

```
┌─────────────────────────────────────────────────────┐
│                   Issue Discovery                    │
│  • Poll GitLab/GitHub API                           │
│  • Filter by label: stage::ready-for-implement      │
└────────────────────┬────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────┐
│              Precondition Validation                 │
│  ✓ AC section exists (## Acceptance Criteria)      │
│  ✓ Base label exists (base::prd-<N> or direct)     │
│  ✓ No open blockers (no blocks-<iid> labels)       │
└────────────────────┬────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────┐
│                 Worktree Creation                    │
│  • Create isolated git worktree                     │
│  • Branch: afk-issue-<iid>                          │
│  • Location: /tmp/afk-worktrees/issue-<iid>         │
└────────────────────┬────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────┐
│              Tmux Session Management                 │
│  • Create session: afk-issue-<iid>                  │
│  • Start Claude Code session in worktree            │
│  • Send goal via /goal command                      │
└────────────────────┬────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────┐
│              Implementation Phase                    │
│  • Claude executes via /afk-implement skill         │
│  • Follows TDD methodology                          │
│  • Writes .afk-signal.json on completion            │
└────────────────────┬────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────┐
│                Signal Detection                      │
│  • Poll .afk-signal.json every 5s                   │
│  • Types: goal_complete, goal_failed, blocked       │
│  • Timeout: configurable (default 2h)               │
└────────────────────┬────────────────────────────────┘
                     │
              ┌──────┴──────┐
              ↓             ↓
    ┌─────────────┐   ┌─────────────┐
    │  Success    │   │   Failure   │
    └──────┬──────┘   └──────┬──────┘
           │                 │
           ↓                 ↓
┌─────────────────┐   ┌─────────────────┐
│ AC Validation   │   │  Label: failed  │
└────────┬────────┘   └─────────────────┘
         │
         ↓
┌─────────────────────────────────────────────────────┐
│              MR/PR Creation                          │
│  • Push branch: afk-issue-<iid>                     │
│  • Create MR/PR with description from issue         │
│  • Link to issue: Closes #<iid>                     │
│  • Add labels from issue                            │
└────────────────────┬────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────┐
│                Cleanup Phase                         │
│  • Update issue labels: stage::in-review            │
│  • Keep worktree for review                         │
│  • Archive tmux session logs                        │
└─────────────────────────────────────────────────────┘
```

## Scheduler Workflow

Dependency-aware background execution system.

### Architecture

```
┌────────────────────────────────────────┐
│         Scheduler Service              │
│  • Poll interval: 60s (configurable)   │
│  • Max concurrent: 3 (configurable)    │
│  • State: Redis or in-memory           │
└────────────────┬───────────────────────┘
                 │
                 ↓
┌────────────────────────────────────────┐
│         Dependency Graph               │
│  • Parse blocks-<iid> labels           │
│  • Build directed acyclic graph        │
│  • Topological sort for execution      │
└────────────────┬───────────────────────┘
                 │
                 ↓
┌────────────────────────────────────────┐
│            Task Queue                  │
│  Priority-based scheduling:            │
│  • High: priority::high label          │
│  • Medium: priority::medium            │
│  • Low: priority::low or no label      │
└────────────────┬───────────────────────┘
                 │
                 ↓
┌────────────────────────────────────────┐
│          Worker Pool                   │
│  Slots: [Worker-1] [Worker-2] [...]   │
│  Each worker:                          │
│  • Picks task from queue               │
│  • Launches workflow                   │
│  • Monitors completion                 │
│  • Updates dependencies                │
└────────────────────────────────────────┘
```

### Dependency Resolution

Issues declare dependencies via labels:

```
Issue #10: base::prd-1, stage::ready-for-implement
Issue #11: base::prd-1, blocks-10, stage::ready-for-implement
Issue #12: base::prd-1, blocks-10, blocks-11, stage::ready-for-implement
```

Scheduler execution order:
1. **#10** starts first (no dependencies)
2. **#11** waits for #10 to complete
3. **#12** waits for both #10 and #11

### Concurrency Control

```typescript
// Pseudocode
class Scheduler {
  maxConcurrent: number = 3;
  activeWorkers: Set<Worker> = new Set();
  
  async processQueue() {
    while (activeWorkers.size < maxConcurrent) {
      const task = queue.dequeue();  // Get highest priority ready task
      if (!task) break;
      
      const worker = new Worker(task);
      activeWorkers.add(worker);
      
      worker.on('complete', () => {
        activeWorkers.delete(worker);
        this.notifyDependents(task.id);  // Unlock blocked tasks
      });
      
      worker.start();
    }
  }
}
```

### State Machine

```
┌──────────┐
│ PENDING  │  Initial state, waiting for dependencies
└────┬─────┘
     │ (dependencies satisfied)
     ↓
┌──────────┐
│  QUEUED  │  Ready to run, in priority queue
└────┬─────┘
     │ (worker available)
     ↓
┌──────────┐
│ RUNNING  │  Workflow actively executing
└────┬─────┘
     │
     ├─→ ┌───────────┐
     │   │ COMPLETED │  Success, MR created
     │   └───────────┘
     │
     ├─→ ┌───────────┐
     │   │  FAILED   │  AC check failed or error
     │   └───────────┘
     │
     └─→ ┌───────────┐
         │  BLOCKED  │  Unresolvable dependency or timeout
         └───────────┘
```

## Skills Workflow

Integration with Claude Code skills for TDD methodology.

### Skill Invocation Chain

```
User request
    ↓
/afk-do  ────────→  Analysis & task breakdown
    │                   ↓
    │              Task list created
    │                   ↓
    └──────────→  /afk-implement (for each task)
                       ↓
                  Implementation:
                  1. /afk-research (if needed)
                  2. Write failing test
                  3. Implement feature
                  4. Pass test
                  5. Progress commit
                       ↓
                  Verification:
                  1. Run full test suite
                  2. Check references/hard-checks.md
                  3. Signal completion
```

### Skill Communication

Skills communicate via three mechanisms:

1. **Task system** (TaskCreate/TaskUpdate):
   ```typescript
   TaskCreate({
     subject: "Implement user authentication",
     description: "Add login endpoint with JWT",
   });
   // Later: TaskUpdate({ taskId: "1", status: "completed" });
   ```

2. **Signal files** (`.afk-signal.json`):
   ```json
   {
     "type": "goal_complete",
     "timestamp": "2026-07-27T10:30:00Z",
     "sha": "abc123def456",
     "summary": "Implemented authentication, 5 tests passing"
   }
   ```

3. **Git state** (commits, branches):
   - Progress commits: `wip: add login endpoint`
   - Final commit: `feat(auth): implement user authentication`

### TDD Methodology Integration

Skills follow Test-Driven Development flow documented in `references/tdd-feature.md`:

**Red Phase:**
```bash
# /afk-implement creates failing test first
$ afk workflow launch --iid 123
# Claude writes test
$ npm test
# ❌ Test fails (expected)
# Progress commit: "test: add authentication test (failing)"
```

**Green Phase:**
```bash
# Claude implements minimal code to pass
$ npm test
# ✅ Test passes
# Progress commit: "feat(auth): implement login endpoint"
```

**Refactor Phase:**
```bash
# Claude improves code quality
$ npm test
# ✅ Tests still pass
# Progress commit: "refactor(auth): extract token validation"
```

**Verification:**
```bash
# Check references/hard-checks.md requirements
✓ All tests passing
✓ No console.log in production code
✓ Error handling present
✓ Types complete (no 'any')
✓ Documentation updated

# Signal completion
$ cat .afk-signal.json
{
  "type": "goal_complete",
  "sha": "final-commit-sha",
  "summary": "Authentication complete: 8 tests passing"
}
```

### Workflow Orchestration in afk-do

`/afk-do` orchestrates the full workflow:

1. **Parse issue** into discrete tasks
2. **For each task**:
   - Check if requires research (`/afk-research`)
   - Invoke `/afk-implement` with specific goal
   - Wait for signal (success/failure/blocked)
3. **Aggregate results** and report
4. **Update issue** labels based on outcome

Example task breakdown:
```
Issue #123: "Add user authentication"

Tasks:
1. Research: Review existing auth patterns → /afk-research
2. Implement: Login endpoint → /afk-implement
3. Implement: Logout endpoint → /afk-implement
4. Implement: Session middleware → /afk-implement
5. Verification: Integration tests → /afk-implement
```

## Signal Types

Workflows communicate state via typed signals:

```typescript
type SignalType = 
  | 'goal_complete'   // Success, ready for review
  | 'goal_failed'     // Tests failing, blockers
  | 'blocked'         // External dependency needed
  | 'needs_input'     // Clarification required
  | 'progress'        // Intermediate update

interface Signal {
  type: SignalType;
  timestamp: string;
  sha?: string;          // Git commit SHA
  summary: string;       // Human-readable message
  metadata?: {           // Optional context
    tests_passed?: number;
    tests_failed?: number;
    blocker_type?: string;
  };
}
```

## Error Handling

### Workflow Failures

```
Failure Type          Action
─────────────────────────────────────────────────
Timeout               • Label: stage::timeout
                      • Keep worktree for inspection
                      • Log to scheduler

Test Failure          • Label: stage::failed
                      • Signal type: goal_failed
                      • Preserve test output

Blocked               • Label: stage::blocked
                      • Signal type: blocked
                      • Add comment explaining blocker

Git Conflict          • Label: stage::conflict
                      • Keep worktree
                      • Notify via comment

API Rate Limit        • Exponential backoff
                      • Retry after cooldown
                      • Log to scheduler
```

### Recovery Procedures

**Orphaned worktrees:**
```bash
# Detect worktrees without active tmux sessions
afk worktree list-orphaned

# Cleanup with confirmation
afk worktree prune
```

**Stale tmux sessions:**
```bash
# List all afk sessions
tmux ls | grep afk-issue

# Kill specific stale session
tmux kill-session -t afk-issue-123
```

**Stuck scheduler:**
```bash
# Check scheduler status
afk scheduler status

# Pause to prevent new starts
afk scheduler pause

# Manually complete stuck tasks
afk scheduler mark-complete --iid 123

# Resume
afk scheduler resume
```

## Performance Considerations

### Concurrency Tuning

```bash
# Conservative (limited resources)
afk scheduler start --max-concurrent 2 --poll-interval 120

# Balanced (typical server)
afk scheduler start --max-concurrent 5 --poll-interval 60

# Aggressive (high-end machine)
afk scheduler start --max-concurrent 10 --poll-interval 30
```

### Resource Usage per Workflow

- **CPU**: 1-2 cores (Claude + tests)
- **Memory**: 500MB-1GB (Node.js process)
- **Disk**: 50-200MB (worktree + node_modules)
- **Network**: API calls + git operations

### Optimization Strategies

1. **Worktree reuse**: Keep worktrees for related issues
2. **Dependency caching**: Share node_modules across worktrees
3. **Parallel AC checks**: Run independent checks concurrently
4. **Batch API calls**: Reduce GitLab/GitHub API hits
5. **Smart polling**: Exponential backoff when queue empty
