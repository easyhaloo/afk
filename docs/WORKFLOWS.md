# AFK 工作流程

## 概述

AFK 实现三种主要工作流模式：
1. **Issue → 实现 → MR 流水线**：手动或自动化 issue 处理
2. **调度器工作流**：后台依赖感知执行
3. **Skills 工作流**：TDD 方法论集成

## Issue → 实现 → MR 流水线

从 issue 发现到合并请求的端到端工作流。

### 手动执行

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

### 自动执行（调度器）

```bash
# Start scheduler daemon
afk scheduler start --max-concurrent 3 --poll-interval 60

# Scheduler automatically:
# 1. Polls for issues with stage::ready-for-implement
# 2. Validates preconditions (AC, base label, no blockers)
# 3. Launches workflows up to max-concurrent limit
# 4. Monitors completion and creates MRs
```

### 工作流阶段

```
┌─────────────────────────────────────────────────────┐
│                   Issue 发现                         │
│  • 轮询 GitLab/GitHub API                           │
│  • 按标签过滤: stage::ready-for-implement           │
└────────────────────┬────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────┐
│                  前置条件验证                        │
│  ✓ AC 章节存在 (## Acceptance Criteria)           │
│  ✓ Base 标签存在 (base::prd-<N> 或 direct)        │
│  ✓ 无未解决阻塞 (无 blocks-<iid> 标签)             │
└────────────────────┬────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────┐
│                 Worktree 创建                        │
│  • 创建隔离的 git worktree                          │
│  • 分支: afk-issue-<iid>                           │
│  • 位置: /tmp/afk-worktrees/issue-<iid>            │
└────────────────────┬────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────┐
│              Tmux 会话管理                           │
│  • 创建会话: afk-issue-<iid>                        │
│  • 在 worktree 中启动 Claude Code 会话              │
│  • 通过 /goal 命令发送目标                          │
└────────────────────┬────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────┐
│                  实现阶段                            │
│  • Claude 通过 /afk-implement skill 执行            │
│  • 遵循 TDD 方法论                                  │
│  • 完成时写入 .afk-signal.json                      │
└────────────────────┬────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────┐
│                  Signal 检测                         │
│  • 每 5s 轮询 .afk-signal.json                      │
│  • 类型: goal_complete, goal_failed, blocked       │
│  • 超时: 可配置（默认 2h）                          │
└────────────────────┬────────────────────────────────┘
                     │
              ┌──────┴──────┐
              ↓             ↓
    ┌─────────────┐   ┌─────────────┐
    │    成功     │   │    失败     │
    └──────┬──────┘   └──────┬──────┘
           │                 │
           ↓                 ↓
┌─────────────────┐   ┌─────────────────┐
│   AC 验证       │   │ 标签: failed    │
└────────┬────────┘   └─────────────────┘
         │
         ↓
┌─────────────────────────────────────────────────────┐
│              MR/PR 创建                              │
│  • 推送分支: afk-issue-<iid>                        │
│  • 用 issue 描述创建 MR/PR                          │
│  • 关联 issue: Closes #<iid>                        │
│  • 添加来自 issue 的标签                            │
└────────────────────┬────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────┐
│                  清理阶段                            │
│  • 更新 issue 标签: stage::in-review                │
│  • 保留 worktree 用于审查                           │
│  • 归档 tmux 会话日志                               │
└─────────────────────────────────────────────────────┘
```

## 调度器工作流

依赖感知的后台执行系统。

### 架构

```
┌────────────────────────────────────────┐
│         调度器服务                      │
│  • 轮询间隔: 60s (可配置)              │
│  • 最大并发: 3 (可配置)                │
│  • 状态: Redis 或内存                  │
└────────────────┬───────────────────────┘
                 │
                 ↓
┌────────────────────────────────────────┐
│         依赖图                          │
│  • 解析 blocks-<iid> 标签              │
│  • 构建有向无环图                      │
│  • 拓扑排序执行                        │
└────────────────┬───────────────────────┘
                 │
                 ↓
┌────────────────────────────────────────┐
│            任务队列                     │
│  基于优先级调度:                       │
│  • 高: priority::high 标签             │
│  • 中: priority::medium                │
│  • 低: priority::low 或无标签          │
└────────────────┬───────────────────────┘
                 │
                 ↓
┌────────────────────────────────────────┐
│          工作池                         │
│  插槽: [Worker-1] [Worker-2] [...]    │
│  每个 worker:                          │
│  • 从队列获取任务                      │
│  • 启动工作流                          │
│  • 监控完成                            │
│  • 更新依赖                            │
└────────────────────────────────────────┘
```

### 依赖解析

Issues 通过标签声明依赖：

```
Issue #10: base::prd-1, stage::ready-for-implement
Issue #11: base::prd-1, blocks-10, stage::ready-for-implement
Issue #12: base::prd-1, blocks-10, blocks-11, stage::ready-for-implement
```

调度器执行顺序：
1. **#10** 首先开始（无依赖）
2. **#11** 等待 #10 完成
3. **#12** 等待 #10 和 #11 都完成

### 并发控制

```typescript
// 伪代码
class Scheduler {
  maxConcurrent: number = 3;
  activeWorkers: Set<Worker> = new Set();
  
  async processQueue() {
    while (activeWorkers.size < maxConcurrent) {
      const task = queue.dequeue();  // 获取最高优先级就绪任务
      if (!task) break;
      
      const worker = new Worker(task);
      activeWorkers.add(worker);
      
      worker.on('complete', () => {
        activeWorkers.delete(worker);
        this.notifyDependents(task.id);  // 解锁被阻塞任务
      });
      
      worker.start();
    }
  }
}
```

### 状态机

```
┌──────────┐
│ PENDING  │  初始状态，等待依赖
└────┬─────┘
     │ (依赖已满足)
     ↓
┌──────────┐
│  QUEUED  │  就绪，在优先级队列中
└────┬─────┘
     │ (worker 可用)
     ↓
┌──────────┐
│ RUNNING  │  工作流正在执行
└────┬─────┘
     │
     ├─→ ┌───────────┐
     │   │ COMPLETED │  成功，MR 已创建
     │   └───────────┘
     │
     ├─→ ┌───────────┐
     │   │  FAILED   │  AC 检查失败或错误
     │   └───────────┘
     │
     └─→ ┌───────────┐
         │  BLOCKED  │  无法解决的依赖或超时
         └───────────┘
```

## Skills 工作流

与 Claude Code skills 集成，实现 TDD 方法论。

### Skill 调用链

```
用户请求
    ↓
/afk-do  ────────→  分析 & 任务分解
    │                   ↓
    │              创建任务列表
    │                   ↓
    └──────────→  /afk-implement (针对每个任务)
                       ↓
                  实现阶段:
                  1. /afk-research (如需要)
                  2. 编写失败测试
                  3. 实现功能
                  4. 通过测试
                  5. 进度提交
                       ↓
                  验证阶段:
                  1. 运行完整测试套件
                  2. 检查 references/hard-checks.md
                  3. Signal 完成
```

### Skill 通信

Skills 通过三种机制通信：

1. **任务系统** (TaskCreate/TaskUpdate):
   ```typescript
   TaskCreate({
     subject: "实现用户认证",
     description: "添加带 JWT 的登录端点",
   });
   // 稍后: TaskUpdate({ taskId: "1", status: "completed" });
   ```

2. **Signal 文件** (`.afk-signal.json`):
   ```json
   {
     "type": "goal_complete",
     "timestamp": "2026-07-27T10:30:00Z",
     "sha": "abc123def456",
     "summary": "已实现认证，5 个测试通过"
   }
   ```

3. **Git 状态** (commits, branches):
   - 进度提交: `wip: add login endpoint`
   - 最终提交: `feat(auth): implement user authentication`

### TDD 方法论集成

Skills 遵循 `references/tdd-feature.md` 中记录的测试驱动开发流程：

**红色阶段：**
```bash
# /afk-implement 首先创建失败测试
$ afk workflow launch --iid 123
# Claude 编写测试
$ npm test
# ❌ 测试失败（预期）
# 进度提交: "test: add authentication test (failing)"
```

**绿色阶段：**
```bash
# Claude 实现最小代码以通过测试
$ npm test
# ✅ 测试通过
# 进度提交: "feat(auth): implement login endpoint"
```

**重构阶段：**
```bash
# Claude 改进代码质量
$ npm test
# ✅ 测试仍然通过
# 进度提交: "refactor(auth): extract token validation"
```
```

**验证：**
```bash
# 检查 references/hard-checks.md 要求
✓ 所有测试通过
✓ 生产代码中无 console.log
✓ 存在错误处理
✓ 类型完整（无 'any'）
✓ 文档已更新

# Signal 完成
$ cat .afk-signal.json
{
  "type": "goal_complete",
  "sha": "final-commit-sha",
  "summary": "认证完成：8 个测试通过"
}
```

### afk-do 中的工作流编排

`/afk-do` 编排完整工作流：

1. **解析 issue** 为离散任务
2. **对于每个任务**:
   - 检查是否需要调研（`/afk-research`）
   - 用特定目标调用 `/afk-implement`
   - 等待 signal（成功/失败/阻塞）
3. **汇总结果** 并报告
4. **根据结果更新 issue** 标签

任务分解示例：
```
Issue #123: "添加用户认证"

任务：
1. 调研: 审查现有认证模式 → /afk-research
2. 实现: 登录端点 → /afk-implement
3. 实现: 登出端点 → /afk-implement
4. 实现: 会话中间件 → /afk-implement
5. 验证: 集成测试 → /afk-implement
```

## Signal 类型

工作流通过类型化 signal 通信状态：

```typescript
type SignalType = 
  | 'goal_complete'   // 成功，准备审查
  | 'goal_failed'     // 测试失败，有阻塞
  | 'blocked'         // 需要外部依赖
  | 'needs_input'     // 需要澄清
  | 'progress'        // 中间更新

interface Signal {
  type: SignalType;
  timestamp: string;
  sha?: string;          // Git commit SHA
  summary: string;       // 人类可读消息
  metadata?: {           // 可选上下文
    tests_passed?: number;
    tests_failed?: number;
    blocker_type?: string;
  };
}
```

## 错误处理

### 工作流失败

```
失败类型              处理方式
─────────────────────────────────────────────────
超时                  • 标签: stage::timeout
                      • 保留 worktree 供检查
                      • 记录到 scheduler

测试失败              • 标签: stage::failed
                      • Signal 类型: goal_failed
                      • 保留测试输出

阻塞                  • 标签: stage::blocked
                      • Signal 类型: blocked
                      • 添加评论说明阻塞原因

Git 冲突              • 标签: stage::conflict
                      • 保留 worktree
                      • 通过评论通知

API 速率限制          • 指数退避
                      • 冷却后重试
                      • 记录到 scheduler
```

### 恢复过程

**孤立的 worktrees：**
```bash
# 检测无活动 tmux 会话的 worktrees
afk worktree list-orphaned

# 带确认的清理
afk worktree prune
```

**过期的 tmux 会话：**
```bash
# 列出所有 afk 会话
tmux ls | grep afk-issue

# 杀死特定过期会话
tmux kill-session -t afk-issue-123
```

**卡住的调度器：**
```bash
# 检查调度器状态
afk scheduler status

# 暂停以防止新启动
afk scheduler pause

# 手动完成卡住的任务
afk scheduler mark-complete --iid 123

# 恢复
afk scheduler resume
```

## 性能考虑

### 并发调优

```bash
# 保守型（资源有限）
afk scheduler start --max-concurrent 2 --poll-interval 120

# 均衡型（典型服务器）
afk scheduler start --max-concurrent 5 --poll-interval 60

# 激进型（高端机器）
afk scheduler start --max-concurrent 10 --poll-interval 30
```

### 每个工作流的资源使用

- **CPU**: 1-2 核（Claude + 测试）
- **内存**: 500MB-1GB（Node.js 进程）
- **磁盘**: 50-200MB（worktree + node_modules）
- **网络**: API 调用 + git 操作

### 优化策略

1. **Worktree 复用** — 为相关 issues 保留 worktrees
2. **依赖缓存** — 跨 worktrees 共享 node_modules
3. **并行 AC 检查** — 并发运行独立检查
4. **批量 API 调用** — 减少 GitLab/GitHub API 请求
5. **智能轮询** — 队列为空时指数退避
