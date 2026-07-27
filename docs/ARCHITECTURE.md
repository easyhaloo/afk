# AFK 架构设计

## 设计目标

AFK (Away From Keyboard) 的核心问题是：**让 AI agent 在隔离环境中自动完成 Issue，并产出可审查的 MR**。

围绕这个目标，系统需要解决四个挑战：

| 挑战 | 解法 |
|------|------|
| 平台差异 | TrackerProvider 抽象层，GitLab/GitHub 统一接口 |
| 并发干扰 | git worktree 物理隔离 + tmux 会话隔离 |
| 状态同步 | 信号文件 + 双向标签同步 |
| 失控保护 | watchdog 硬超时 + 重试升级到 HITL |

---

## 核心架构

### 模块依赖图

```mermaid
graph TD
    CLI["CLI 入口 (commander)"]
    Factory["createTrackerClient 工厂函数"]
    Detect["detectProject 平台检测"]
    GL["GitLabClient"]
    GH["GitHubClient"]
    Runner["WorkflowRunner 工作流编排"]
    WT["WorktreeManager (git worktree)"]
    TMUX["TmuxClient 会话管理"]
    SIG["Signal I/O 信号读写 (.afk-signal.json)"]
    STATUS["Status I/O 状态读取 (.afk/claude-status.json)"]
    SCONF["Statusline Config 自动注入到 worktree settings"]
    Sched["Scheduler (BullMQ)"]
    Queue[("Redis Queue")]
    Agent["AI Agent (claude)"]

    CLI --> Factory
    Factory --> Detect
    Factory --> GL
    Factory --> GH

    CLI --> Runner
    GL --> Runner
    GH --> Runner

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

    classDef ext fill:#e1f5ff,stroke:#0066cc
    classDef core fill:#fff4e1,stroke:#cc6600
    classDef io fill:#f0e1ff,stroke:#6600cc

    class CLI,Agent ext
    class Runner,Factory,GL,GH,Sched core
    class WT,TMUX,SIG,STATUS,SCONF,Queue io
```

### 模块职责

| 模块 | 职责 | 关键设计决策 |
|------|------|-------------|
| **TrackerProvider** | 平台无关的 Issue/MR 操作 | 接口契约，多平台实现 |
| **WorkflowRunner** | 编排完整生命周期 | 信号驱动 + statusline 客观校验 |
| **WorktreeManager** | 每个 Issue 独立工作区 | 物理隔离，避免分支冲突 |
| **TmuxClient** | Agent 运行环境 | 独立会话，崩溃不互相影响 |
| **Signal I/O** | Agent↔Runner 控制通信 | 文件原子写入，Zod 校验 |
| **Status I/O** | 读取 Claude statusline JSON | token 客观数据源 |
| **Statusline Config** | 自动注入 worktree settings.json | tee stdin JSON 到文件 |
| **Scheduler** | 多 Issue 并发调度 | BullMQ + 优先级队列 |

---

## 关键设计决策

### 1. 为什么是文件信号，不是 IPC？

Agent 运行在 tmux session 中，与调度系统是**进程隔离**的。考虑过三种通信方式：

| 方案 | 优点 | 否决原因 |
|------|------|---------|
| Unix Socket | 低延迟 | 跨进程生命周期管理复杂，Agent 崩溃后 socket 残留 |
| HTTP 长连接 | 可双向推送 | 需要在 Agent 内常驻服务，违反"无侵入"原则 |
| **文件信号** | **进程崩溃后状态可恢复** | **采用** |

**关键设计：**
- 原子写入（tmp + rename），避免读到半截 JSON
- Zod schema 校验，版本不兼容时快速失败

### 1b. 为什么 context_high 不信任 Agent 自报？

LLM 倾向于"乐观报告"。让 Agent 自己判断"我上下文快满了"会出现：
- **漏报**：真的快满了但 Agent 觉得"还行" → 截断崩溃
- **误报**：Agent 谨慎过头 → 不必要的 handoff 浪费 token 和上下文

正确做法：**Agent 仅作触发器，Runner 做客观校验**。Agent 发 `context_high` 信号不带数据，Runner 读取 Claude statusline JSON 中的 token 计数，与 `CONTEXT.HIGH_THRESHOLD`（默认 100K）比较后才决定是否 handoff。

### 2. 为什么是 Worktree，不是 Docker？

| 方案 | 启动开销 | 隔离强度 | 磁盘占用 |
|------|---------|---------|---------|
| Docker 容器 | 5-10s | 进程级 | GB/容器 |
| **git worktree** | **<1s** | **文件级** | **MB/worktree** |

Agent 需要的是**分支隔离**，不是**进程隔离**。worktree 共享 `.git` 目录但工作区独立，切换开销几乎为零。

### 3. 为什么需要 Watchdog？

Agent 可能因为以下原因卡住：
- 等待用户输入（不该发生，但 skill 设计缺陷时会有）
- 死循环或递归调用
- 网络请求 hang

**两层防护：**
- `completionTimeoutMs`（默认 5min）：软超时，触发 signal 检测
- `hardTimeoutMs`（默认 60min）：硬超时，watchdog 直接 `kill-session`

watchdog 用 `setsid` 启动独立进程，**即使父进程崩溃也能触发**。

### 4. 为什么 AC 失败要重试而不是直接 HITL？

AC 失败的常见原因：
- Agent 误解需求（50%）→ 重试 + 更明确的 AC 通常能通过
- 真正的实现缺陷（30%）→ 重试 + 修改代码
- 需求本身有问题（20%）→ 需要 HITL

直接升级到 HITL 会把 80% 的可自动化场景拱手让给人类。**重试机制保留自动化的核心价值**。

---

## 跨平台抽象层

### 分层架构

```mermaid
graph TD
    Biz["业务代码 (WorkflowRunner / Commands)"]
    IF["TrackerProvider 接口契约"]
    GL["GitLabClient (@gitbeaker/node)"]
    GH["GitHubClient (@octokit/rest)"]
    GL_API["GitLab REST API"]
    GH_API["GitHub REST API"]

    Biz -->|只依赖| IF
    IF -.实现.-> GL
    IF -.实现.-> GH

    GL --> GL_API
    GH --> GH_API

    classDef biz fill:#e1f5ff
    classDef impl fill:#fff4e1
    class IF biz
    class GL,GH impl
```

**核心原则：差异封装在 client 内部，接口保持语义一致。**

### 平台差异处理

| 差异 | GitLab | GitHub | 抽象策略 |
|------|--------|--------|---------|
| Issue ID | `iid` | `number` | 统一为 `id: number` |
| 创建 MR 加标签 | API 原生支持 | 需额外 API 调用 | GitHubClient 内部自动处理 |
| 合并时删分支 | `removeSourceBranch` 参数 | 单独 `git.deleteRef` | 封装在 `mergeMR()` 中 |
| Issue 关联 | 原生 `Issues.link()` | 只能通过评论引用 | GitHubClient 降级为评论 |

### 平台检测流程

```mermaid
flowchart TD
    Start([启动]) --> Env{"TRACKER_PLATFORM 环境变量?"}
    Env -->|设置| ReturnEnv[返回指定平台]
    Env -->|未设置| Remote[解析 git remote URL]
    Remote --> RemoteCheck{URL 域名?}
    RemoteCheck -->|github.com| GH[GitHub]
    RemoteCheck -->|gitlab.com| GL[GitLab]
    RemoteCheck -->|其他| Config[检查配置文件]
    Config --> ConfigCheck{找到?}
    ConfigCheck -->|.github/workflows| GH
    ConfigCheck -->|.gitlab-ci.yml| GL
    ConfigCheck -->|都没有| Default[默认 GitLab]

    classDef detected fill:#d4edda,stroke:#28a745
    class GH,GL detected
```

**检测优先级：** 环境变量 > git remote > 配置文件 > 默认 GitLab

---

## 信号协议

### 两种数据通道

系统通过两条通道与 Agent 通信，各有侧重：

| 通道 | 数据 | 写入方 | 读取方 | 用途 |
|------|------|--------|--------|------|
| `.afk-signal.json` | 控制事件 | Agent | Runner 轮询 | goal_complete / ac_result / timeout / context_high |
| `.afk/claude-status.json` | 客观状态 | Claude Code statusline | Runner 按需 | token 计数、模型、上下文窗口 |

**设计原则：控制信号走文件（Agent 主动），状态数据走 statusline（引擎自动推送）**。

### 信号类型（控制通道）

| 信号 | 触发场景 | 系统响应 |
|------|---------|---------|
| `goal_complete` | Agent 完成目标 | 进入 AC 验收 |
| `ac_result` | AC 检查结果 | PASS→创建 MR，FAIL→重试或升级 |
| `timeout` | 硬超时 | 捕获日志，添加 `mode::timeout` 标签 |
| `context_high` | Agent 怀疑上下文过高 | Runner 读取 statusline JSON 校验阈值后决定 |
| `handoff_ready` | 上下文切换完成 | 关闭旧 session，启动新 session |

### 信号生命周期

```mermaid
sequenceDiagram
    participant A as Agent
    participant FS as .afk-signal.json
    participant R as WorkflowRunner
    participant H as Handler

    loop 执行循环
        A->>A: 工作进展
        A->>FS: 写信号 (原子写入)
        Note over FS: tmp + rename

        R->>FS: 轮询 (2s 间隔)
        alt 信号匹配预期类型
            FS-->>R: 返回信号
            R->>H: 分发到对应 handler
        else 类型不匹配
            FS-->>R: null
            R->>R: 继续轮询
        end
    end

    opt 超时
        R->>R: 等待超过 completionTimeoutMs
        R->>H: 触发 timeout handler
    end
```

### 状态数据流（状态通道）

Claude Code statusline 在每回合自动通过 stdin 推送 JSON payload。AFK 在 worktree 创建时自动配置 statusline 用 tee 命令同时写入文件：

```mermaid
sequenceDiagram
    participant CC as Claude Code 引擎
    participant Tee as tee (statusline 入口)
    participant SL as ccstatusline 渲染
    participant JSON as .afk/claude-status.json
    participant R as WorkflowRunner

    loop 每回合
        CC->>Tee: stdin JSON (model, tokens, cost...)
        Tee->>JSON: 写入文件
        Tee->>SL: 透传给用户渲染
    end

    Note over R: context_high 信号触发时按需读取
    R->>JSON: readClaudeStatus(worktreeDir)
    JSON-->>R: Zod 校验后返回
    R->>R: extractTokenUsage → 阈值校验
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
  // ... 其他字段忽略
}
```

### 为什么 Zod 校验？

信号文件跨进程边界，**格式错误是常态而非异常**：
- Agent skill 版本不匹配
- 手动编辑的测试信号
- 网络问题导致写入中断

Zod 在边界处快速失败，比让 `undefined.sha` 这种错误传播到深处再崩溃要好。

### 为什么从 pane 正则改为 statusline JSON？

旧实现用 `tmux capture-pane` + 正则匹配 "Xk tokens" 文本，存在三个问题：
1. **脆弱**：Claude Code UI 文案变化即失效
2. **性能差**：每次轮询都 capture pane 大输出
3. **信息不完整**：拿不到 cache_read/cache_creation

新实现通过 statusline stdin JSON 读取，**数据源是官方 API**，UI 变化不影响，且一次拿到全部细分字段。

---

## WorkflowRunner 流程

### 核心状态机

```mermaid
stateDiagram-v2
    [*] --> Init: run(iid)

    Init: 初始化 - getIssue / parseAC
    Worktree: 创建 Worktree
    TmuxLaunch: 启动 Tmux Session
    Watchdog: 启动 Watchdog
    Comment: 发布启动评论
    Polling: 等待信号

    Init --> Worktree
    Worktree --> TmuxLaunch
    TmuxLaunch --> Watchdog
    Watchdog --> Comment
    Comment --> Polling

    Polling --> AutoWrapup: goal_complete
    Polling --> Timeout: timeout
    Polling --> Handoff: context_high

    AutoWrapup: autoWrapup - AC 验收 + MR
    Timeout: handleTimeout - 日志 + 标签
    Handoff: handleHandoff - 上下文切换

    AutoWrapup --> RetryCheck: ac_result FAIL
    AutoWrapup --> Success: ac_result PASS
    RetryCheck --> HITL: retry > max
    RetryCheck --> [*]: 重试新 session

    Success --> [*]: MR 创建完成
    Timeout --> [*]: 升级或重试
    Handoff --> Polling: handoff_ready
    HITL --> [*]: 人工介入
```

### 时序图：完整生命周期

```mermaid
sequenceDiagram
    participant U as 用户/CLI
    participant W as WorkflowRunner
    participant T as TrackerProvider
    participant G as Git/Worktree
    participant M as TmuxClient
    participant A as AI Agent
    participant Wd as Watchdog

    U->>W: afk implement iid
    W->>T: getIssue(iid)
    T-->>W: TrackedIssue
    W->>W: parseAC(description)

    W->>G: createWorktree(iid, baseBranch)
    G-->>W: Worktree

    par 并行启动
        W->>M: createSession(name, wt.path, claude)
        M->>A: spawn claude process
        W->>Wd: setsid sleep hardTimeoutMs
        Note over Wd: 独立进程，父进程崩溃也能触发
    end

    M->>W: waitForPrompt()
    W->>M: sendGoal(goalText)
    M->>A: 发送 /goal + AC

    A->>A: 实现功能 + 提交 commits

    loop 信号轮询 (每 2s)
        W->>A: read .afk-signal.json
        alt goal_complete
            A-->>W: goal_complete signal
            W->>G: pushBranch()
            W->>A: sendResumeWithAC()
            A->>A: 逐条检查 AC
            A-->>W: ac_result PASS
            W->>T: createMR(iid, branch, target)
            T-->>W: MR URL
            W->>T: addLabel(stage::qa)
        else timeout (5min)
            W->>A: 检查 pane 内容
            Note over W: 软超时，继续等待
        end
    end

    opt 硬超时 (60min)
        Wd->>M: kill-session
        W->>T: addLabel(mode::timeout)
    end
```

### autoWrapup 的关键设计

AC 验收不是"问 Agent 你做完了吗"，而是：
1. 推送分支到 origin
2. 让 Agent **逐条检查 AC 并产出结构化结果**
3. **WorkflowRunner 解析结果**，不信任 Agent 的自我评价

**为什么不让 Agent 自我评估？**
LLM 倾向于"乐观报告"。把结果解析权交给系统，是把评估责任从"被评估者"移到"评估者"。

### 重试机制

```mermaid
flowchart TD
    AC[AC FAIL] --> Inc[incrementRetryCount]
    Inc --> Check{retryCount > maxRetries?}
    Check -->|是| HITL["addLabel mode::hitl, addComment escalating"]
    Check -->|否| Kill[killSession 旧 session]
    Kill --> New[创建新 session retry-N]
    New --> Run[重新跑 WorkflowRunner]
    Run --> AC

    HITL --> End[返回 success: false]

    classDef fail fill:#f8d7da,stroke:#dc3545
    classDef success fill:#d4edda,stroke:#28a745
    class AC,Inc fail
    class End success
```

**关键：每个 retry 都是新 session**，不是同一个 session 继续跑。这避免了上下文污染，也符合 Claude Code 的会话独立性。

---

## Scheduler 设计

### 为什么需要 Scheduler？

`afk implement <iid>` 是单次命令。Scheduler 解决：
- **自动发现**：轮询 GitLab 找 `stage::ready-for-implement` 的 Issue
- **并发控制**：避免一台机器跑 10 个 Agent 把 CPU/内存打爆
- **优先级调度**：`priority::high` 优先于 `priority::low`
- **失败重试**：BullMQ 内置指数退避

### 调度流程

```mermaid
sequenceDiagram
    participant S as Scheduler
    participant GL as GitLab API
    participant Q as BullMQ Queue
    participant W as Worker
    participant R as WorkflowRunner

    loop 定时轮询
        S->>GL: listIssues(label: ready-for-implement)
        GL-->>S: issues list

        loop 每个 Issue
            S->>S: checkIssuePreconditions
            S->>Q: getJob(issue-N)
            alt 已入队
                Q-->>S: job exists
                S->>S: skip
            else 未入队
                S->>S: calculatePriority(labels)
                S->>Q: enqueue(issue, priority)
                Q-->>S: jobId
            end
        end
    end

    Q->>W: 派发 job
    W->>R: runner.run
    R-->>W: success result

    alt 成功
        W->>GL: removeLabel(ready-for-implement)
        W->>GL: addLabel(stage::qa)
    else 失败
        W->>Q: 抛出错误
        Note over Q: 触发指数退避重试
    end
```

### 优先级映射

| 标签 | 优先级 |
|------|--------|
| `priority::high` | 10 |
| `priority::medium` | 5 |
| `priority::low` | 1 |
| （无） | 5 |

**去重机制：** `queue.getJob('issue-123')` 检查是否已入队，避免重复提交。

---

## CLI 命令系统

### Lazy-Loader 设计

```mermaid
graph LR
    A["CLI 启动 ~50ms"] --> B["命令注册: 仅注册元数据"]
    B --> C{"用户执行哪个命令?"}
    C -->|afk issue get| D["动态 import tracker.ts"]
    C -->|afk scheduler| E["动态 import scheduler.ts"]
    C -->|afk implement| F["动态 import implement.ts"]

    D --> G["加载依赖 @gitbeaker"]
    E --> H["加载依赖 bullmq + ioredis"]
    F --> I["加载依赖 workflow runner"]

    classDef fast fill:#d4edda
    classDef lazy fill:#fff4e1
    class A,B,C fast
    class D,E,F,G,H,I lazy
```

**为什么？** 加载所有命令的依赖会拖慢 `afk --help` 这种轻量命令的响应。Lazy-loader 把启动时间从 ~500ms 降到 ~50ms。

### 命令结构

| 命令族 | 文件 | 说明 |
|--------|-----|------|
| `afk issue <cmd>` | `tracker.ts` | Issue CRUD，自动检测平台 |
| `afk mr <cmd>` | `tracker.ts` | MR/PR 创建、合并、审查 |
| `afk implement <iid>` | `implement.ts` | 启动单次 workflow |
| `afk scheduler <cmd>` | `scheduler.ts` | 启动/停止/查看调度器 |
| `afk worktree <cmd>` | `worktree.ts` | 列出/清理 worktree |

---

## 技术栈选型

| 选型 | 替代方案 | 选择理由 |
|------|---------|---------|
| **TypeScript** | Go/Rust | LLM 代码生成友好；Node 生态成熟 |
| **commander** | yargs/oclif | 轻量、API 稳定 |
| **BullMQ** | 自研队列 | Redis 持久化、内置重试、可视化面板 |
| **tmux** | 子进程管理 | 进程隔离 + 可观测（attach 看输出） |
| **git worktree** | 分支切换 | 物理隔离，零切换开销 |
| **Zod** | io-ts/typebox | 错误信息友好，生态成熟 |
| **Ink** | blessed/ratatui | React-based，组件化 TUI |

---

## 扩展点

### 添加新平台（以 Bitbucket 为例）

```mermaid
graph LR
    A[实现 TrackerProvider 接口] --> B[在 detectProject 添加 URL 识别]
    B --> C[在 createTrackerClient 注册分支]
    C --> D[封装平台特定差异]
    D --> E[无需修改业务逻辑]

    classDef new fill:#d4edda
    class A,B,C,D,E new
```

**无需修改**：WorkflowRunner、业务命令、Scheduler

### 添加新信号类型

1. 在 `SignalSchema` 中定义 Zod schema
2. 在 WorkflowRunner 的 `waitForAnySignal()` 中添加新类型
3. 添加对应的 handler 方法
4. 更新 Agent skill 指令

### 利用 statusline 数据做更智能决策

statusline JSON 提供丰富会话元数据（token 用量、缓存命中率、成本、模型等）。除 context_high 外，未来可在这些场景用上：

| 决策 | 所需字段 | 阈值常量 |
|------|---------|---------|
| 触发提前 handoff | `cache_read_input_tokens` 占比 | 待定 |
| 成本告警 | `cost.total_cost_usd` | 待定 |
| 模型切换判断 | `model.display_name` | 配置驱动 |
| 缓存策略评估 | `cache_creation_input_tokens` 增长率 | 待定 |

扩展方法：在 `src/lib/core/io/status.ts` 的 `extractTokenUsage()` 添加聚合字段；在 `constants.ts` 添加阈值；WorkflowRunner 中按需读取。

### 自定义 Workflow 钩子

RunnerOptions 支持 `customValidation` 等钩子，在 AC 检查前后插入自定义逻辑（lint、性能测试、截图验证等）。

---

## 状态文件

| 文件 | 内容 | 写入方 | 读取方 |
|------|------|--------|--------|
| `.afk/worktrees.json` | Worktree 元数据 | WorktreeManager | WorktreeManager / CLI |
| `<worktree>/.afk-signal.json` | 控制信号 | Agent | WorkflowRunner 轮询 |
| `<worktree>/.afk/claude-status.json` | Claude statusline payload | statusline tee | Runner 按需（context_high 校验） |
| `<worktree>/.afk/CRASHED` | 异常退出标记 | watchdog | WorktreeManager |
| `<worktree>/.afk/SUCCESS` | 成功完成标记 | workflow 结束 | WorktreeManager |
| `<worktree>/.claude/settings.json` | 自动注入的 statusline 配置 | configureStatusline | Claude Code |
| `~/.claude/logs/afk/` | 超时日志、watchdog 记录 | handleTimeout / watchdog | 运维 |

---

## 常见问题

### Q: 平台检测失败

设置 `TRACKER_PLATFORM=gitlab` 或确保 `git remote -v` 包含可识别的域名。

### Q: AC 一直失败

检查 Issue 描述中的 AC 是否清晰、机器可验证。模糊的 AC（如"代码质量好"）会导致 agent 反复猜测。

### Q: Worktree 占用空间

`afk worktree clean --stale` 清理 7 天未活动的 worktree。

### Q: 如何调试单个 Issue？

`afk implement <iid> --dry-run` 跳过实际执行，只打印计划。

---

## 相关文档

- [快速开始](GETTING-STARTED.md) — 安装和配置
- [工作流程](WORKFLOWS.md) — Issue → MR 完整流程
- [Skills 说明](SKILLS.md) — 8 个 Claude Code skills