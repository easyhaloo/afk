# CLI Modernization Analysis

## Current Pain Points in Bash Implementation

### 1. GitLab API Interactions (High Priority)

**Current:** Bash wrapper around `glab` CLI
```bash
glab_safe() {
  local cmd=("$@")
  local attempt=1
  local max_retries="${AFK_GITLAB_RETRY_MAX:-3}"
  
  while (( attempt <= max_retries )); do
    output=$(glab "${cmd[@]}" 2>&1) && {
      echo "$output"
      return 0
    }
    # ... 复杂的错误解析逻辑
  done
}
```

**Problems:**
- ❌ JSON 解析依赖 `jq`（额外依赖）
- ❌ 错误处理分散（HTTP code、rate limit、network error）
- ❌ 无类型安全（字段拼写错误运行时才发现）
- ❌ 难以测试（需要 mock glab 命令）
- ❌ 无智能缓存（每次都调用 API）

**Solution:** TypeScript CLI with GitLab SDK
```typescript
// afk-gitlab-cli
import { Gitlab } from '@gitbeaker/node';

interface IssueWithAC {
  iid: number;
  title: string;
  description: string;
  ac: string[];
  labels: string[];
}

async function getIssue(iid: number): Promise<IssueWithAC> {
  const issue = await gitlab.Issues.show(PROJECT_ID, iid);
  const ac = extractAC(issue.description);
  return { ...issue, ac };
}

// Auto retry with exponential backoff built-in
// Type-safe API calls
// Structured error handling
```

**Benefits:**
- ✅ Type safety (TypeScript)
- ✅ Built-in retry/backoff (GitLab SDK)
- ✅ Structured error types
- ✅ Unit testable
- ✅ Smart caching (Redis/file-based)

---

### 2. Signal File Management (Medium Priority)

**Current:** Manual JSON construction in Bash
```bash
cat > .afk-signal.json <<'EOF'
{"type":"goal_complete","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","sha":"$(git rev-parse HEAD)"}
EOF
```

**Problems:**
- ❌ JSON 格式容易出错（引号转义、换行）
- ❌ 无 schema 验证
- ❌ Agent 需要手写 JSON（容易出错）
- ❌ 读取需要 `jq`

**Solution:** Python CLI with Pydantic
```python
# afk-signal
from pydantic import BaseModel
from datetime import datetime
from pathlib import Path

class GoalCompleteSignal(BaseModel):
    type: Literal["goal_complete"]
    timestamp: datetime
    sha: str
    summary: str

def write_signal(signal: BaseModel):
    Path(".afk-signal.json").write_text(signal.json(indent=2))

# CLI usage:
# afk-signal goal-complete --summary "Implemented feature X"
# afk-signal ac-result --result PASS --tests-run 12
```

**Benefits:**
- ✅ Schema 验证（Pydantic）
- ✅ Type safety
- ✅ Agent 调用简单：`afk-signal goal-complete --summary "..."`
- ✅ 自动生成 timestamp, sha

---

### 3. Tmux Session Management (High Priority)

**Current:** Raw tmux commands with string parsing
```bash
tmux send-keys -t "${session}:${window}" -- "/goal"
tmux send-keys -t "${session}:${window}" C-m
pane_content=$(tmux capture-pane -t "${session}:${window}" -p -S -100 | tail -50)
```

**Problems:**
- ❌ 多次 send-keys 易出错
- ❌ 时序问题（sleep 硬编码）
- ❌ 难以追踪 pane 状态
- ❌ 错误处理分散

**Solution:** TypeScript CLI with tmux control mode
```typescript
// afk-tmux
import { TmuxClient } from 'tmux-control-mode';

class ClaudeSession {
  async sendGoal(goalText: string): Promise<void> {
    await this.waitForPrompt(); // 智能等待 ❯
    await this.send(`/goal ${goalText}`);
  }
  
  async waitForSignal(type: string, timeout: number): Promise<Signal> {
    // Poll signal file + pane output in parallel
    return Promise.race([
      this.watchSignalFile(type),
      this.watchPaneOutput(type),
      this.timeout(timeout)
    ]);
  }
  
  async capture(lines: number): Promise<string> {
    return this.client.capturePane({ history: lines * 2, tail: lines });
  }
}

// CLI usage:
// afk-tmux send-goal --session afk --iid 123
// afk-tmux wait-signal --type goal_complete --timeout 300
```

**Benefits:**
- ✅ 原子操作（send + wait 合并）
- ✅ 智能等待（不需要硬编码 sleep）
- ✅ 统一错误处理
- ✅ 可测试（mock tmux client）

---

### 4. Worktree Management (Medium Priority)

**Current:** Git worktree + manual cleanup
```bash
git worktree add -b "afk-issue-${iid}" "$wt_path" "$target_branch"
trap "git worktree remove --force '$wt_path' 2>/dev/null || true" EXIT
```

**Problems:**
- ❌ Cleanup 逻辑分散
- ❌ 错误时可能遗留 worktree
- ❌ 无状态追踪（哪些 worktree 是活跃的）

**Solution:** TypeScript CLI with state tracking
```typescript
// afk-worktree
import { simpleGit } from 'simple-git';

interface WorktreeState {
  iid: number;
  path: string;
  branch: string;
  sessionId: string;
  createdAt: Date;
  status: 'active' | 'completed' | 'failed';
}

class WorktreeManager {
  private stateFile = '.afk/worktrees.json';
  
  async create(iid: number): Promise<string> {
    const path = await this.git.worktreeAdd(...)
    await this.saveState({ iid, path, status: 'active', ... });
    return path;
  }
  
  async cleanup(iid: number): Promise<void> {
    const state = await this.getState(iid);
    if (state.status === 'active') {
      await this.git.worktreeRemove(state.path);
    }
    await this.deleteState(iid);
  }
  
  async listOrphaned(): Promise<WorktreeState[]> {
    // 检测没有对应 tmux session 的 worktree
  }
}

// CLI usage:
// afk-worktree create --iid 123 --branch main
// afk-worktree cleanup --iid 123
// afk-worktree list-orphaned
```

**Benefits:**
- ✅ 集中状态管理
- ✅ 自动检测孤儿 worktree
- ✅ 可靠的 cleanup
- ✅ 审计日志

---

### 5. Scheduler Orchestration (High Priority)

**Current:** Bash script with manual polling
```bash
while true; do
  ready_issues=$(glab issue list --label "stage::ready-for-implement" ...)
  for iid in $ready_issues; do
    if can_start_session; then
      launch_agent "$iid" &
    fi
  done
  sleep "${AFK_SCHEDULER_INTERVAL:-60}"
done
```

**Problems:**
- ❌ 单线程轮询（效率低）
- ❌ 无优先级队列
- ❌ 无并发控制策略
- ❌ 难以监控（日志分散）

**Solution:** TypeScript/Python async scheduler
```typescript
// afk-scheduler
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

interface Task {
  iid: number;
  priority: number;
  createdAt: Date;
  retries: number;
}

class AFKScheduler {
  private queue: Queue<Task>;
  private maxConcurrent = parseInt(process.env.AFK_MAX_CONCURRENT || '3');
  
  async start() {
    // Watch GitLab webhook events (real-time, not polling)
    await this.gitlab.on('issue.label_added', async (event) => {
      if (event.label === 'stage::ready-for-implement') {
        await this.enqueue(event.iid, this.calculatePriority(event));
      }
    });
    
    // Process queue with concurrency control
    this.queue.process(this.maxConcurrent, async (job) => {
      return this.executeTask(job.data);
    });
  }
  
  private calculatePriority(issue: Issue): number {
    // Priority logic: due date, labels, dependencies
    return issue.labels.includes('priority::high') ? 10 : 5;
  }
}

// CLI usage:
// afk-scheduler start --max-concurrent 5
// afk-scheduler status
// afk-scheduler pause --iid 123
```

**Benefits:**
- ✅ 事件驱动（不是轮询）
- ✅ 优先级队列
- ✅ 并发控制
- ✅ 持久化队列（Redis）
- ✅ 实时监控（Web UI）

---

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     afk-scheduler (TS)                      │
│  - Event-driven task queue (BullMQ + Redis)                │
│  - GitLab webhook listener (real-time)                     │
│  - Concurrency control & priority queue                    │
│  - Web UI for monitoring (Express + React)                 │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ├─── afk-gitlab (TS)
                     │    - Type-safe GitLab API client
                     │    - Smart caching & retry logic
                     │    - Issue parser (extract AC)
                     │
                     ├─── afk-tmux (TS)
                     │    - Claude session manager
                     │    - Intelligent wait (prompt/signal)
                     │    - Structured output capture
                     │
                     ├─── afk-signal (Python)
                     │    - Pydantic-based schema validation
                     │    - Simple CLI for agent to use
                     │    - Watch API (inotify-based)
                     │
                     ├─── afk-worktree (TS)
                     │    - State-tracked worktree manager
                     │    - Orphan detection & cleanup
                     │    - Audit logs
                     │
                     └─── afk-workflow (TS)
                          - High-level orchestration
                          - AC check → MR creation pipeline
                          - Handoff logic

┌─────────────────────────────────────────────────────────────┐
│              Shared Infrastructure (optional)                │
│  - Redis: task queue + caching                              │
│  - PostgreSQL: audit logs + state (optional)                │
│  - Prometheus: metrics export                               │
└─────────────────────────────────────────────────────────────┘
```

---

## Implementation Strategy

### Phase 1: Core Tools (Week 1-2)
**Priority: Replace most fragile parts first**

1. **afk-gitlab** (TypeScript)
   - Replace `_lib/gitlab-safe.sh`
   - Commands: `get-issue`, `update-label`, `create-mr`, `add-comment`
   - Built-in retry/cache/error handling

2. **afk-signal** (Python)
   - Replace manual JSON in signal.sh
   - Commands: `goal-complete`, `ac-result`, `handoff-ready`, `watch`
   - Pydantic validation

3. **afk-tmux** (TypeScript)
   - Replace tmux.sh + parts of claude-agent.sh
   - Commands: `send-goal`, `wait-signal`, `capture`, `create-session`

### Phase 2: Orchestration (Week 3-4)

4. **afk-workflow** (TypeScript)
   - Replace workflow.sh
   - Higher-level operations: `run-ac`, `create-mr`, `trigger-handoff`

5. **afk-worktree** (TypeScript)
   - Replace worktree management in claude-agent.sh
   - Commands: `create`, `cleanup`, `list`, `prune-orphaned`

### Phase 3: Scheduler (Week 5-6)

6. **afk-scheduler** (TypeScript)
   - Replace scheduler.sh
   - Event-driven queue + Web UI
   - Real-time GitLab webhooks

---

## Migration Path (Incremental)

### Step 1: Introduce CLI alongside Bash
```bash
# claude-agent.sh (hybrid)
if command -v afk-gitlab >/dev/null 2>&1; then
  issue_json=$(afk-gitlab get-issue "$iid")  # Use CLI
else
  issue_json=$(glab_safe issue view "$iid" --json)  # Fallback to bash
fi
```

### Step 2: Deprecate Bash functions
```bash
# _lib/gitlab-safe.sh
glab_safe() {
  echo "DEPRECATED: Use 'afk-gitlab' CLI instead" >&2
  afk-gitlab "$@"
}
```

### Step 3: Remove Bash entirely
- After 1-2 months of CLI usage
- Keep minimal bash wrappers for backward compat

---

## Technology Stack Recommendation

### Option A: TypeScript (Recommended)
**Pros:**
- ✅ Single language for all tools (consistency)
- ✅ Excellent GitLab SDK (@gitbeaker)
- ✅ Rich ecosystem (BullMQ, tmux libs)
- ✅ Type safety end-to-end
- ✅ Easy to distribute (npx, npm)

**Cons:**
- ❌ Slightly heavier runtime (Node.js)

### Option B: Python
**Pros:**
- ✅ Excellent for signal validation (Pydantic)
- ✅ Good GitLab SDK (python-gitlab)
- ✅ Great for data processing

**Cons:**
- ❌ Tmux integration less mature
- ❌ Async patterns more verbose

### Option C: Go
**Pros:**
- ✅ Single binary (no runtime needed)
- ✅ Fast execution
- ✅ Good concurrency primitives

**Cons:**
- ❌ GitLab SDK less mature
- ❌ JSON handling more verbose
- ❌ Slower development cycle

**Recommendation: TypeScript for all except signal validation (Python)**

---

## Estimated Impact

| Metric | Before (Bash) | After (TS/Py CLI) | Improvement |
|--------|---------------|-------------------|-------------|
| Lines of code | ~2000 | ~1200 | -40% |
| Test coverage | 0% | 80%+ | +∞ |
| Error clarity | Low (exit codes) | High (typed errors) | +90% |
| Maintainability | 3/10 | 8/10 | +167% |
| Reliability | 9.0/10 | 9.5/10 | +5% |
| Development speed | Slow | Fast | +50% |
| Onboarding time | 2-3 days | 4-6 hours | -70% |

---

## Cost-Benefit Analysis

### Costs
- **Development time:** 4-6 weeks (incremental)
- **Learning curve:** TypeScript ecosystem (if unfamiliar)
- **Dependencies:** Node.js runtime, npm packages
- **Migration risk:** Need parallel Bash fallback during transition

### Benefits
- **Long-term velocity:** Faster feature development (type safety, tests)
- **Reduced bugs:** Compiler catches errors before runtime
- **Better observability:** Structured logging, metrics
- **Easier onboarding:** Modern tooling, familiar patterns
- **Extensibility:** Easy to add Web UI, webhooks, monitoring

**ROI:** Break-even after 2-3 months; positive thereafter

---

## Next Steps

1. **Prototype afk-gitlab CLI** (2-3 days)
   - Implement `get-issue`, `update-label` commands
   - Compare performance/reliability with Bash version
   - Gather feedback

2. **Prototype afk-signal CLI** (1 day)
   - Pydantic schemas for all signal types
   - Agent-friendly interface
   - Test with real workflows

3. **Decision point:** Full migration vs selective replacement
   - If prototypes succeed → proceed with Phase 1
   - If issues found → revise strategy

4. **Parallel implementation:** Start Phase 1 while keeping Bash stable
