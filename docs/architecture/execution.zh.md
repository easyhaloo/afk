# AFK 执行环境与多 Agent 工作流设计

## 1. 目标

在不破坏现有 Issue、Tracker、QA、HITL 和 TUI 能力的前提下，将 AFK 的执行层改造成可扩展架构：

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

核心要求：

- `local` 模式保留当前 `tmux + worktree` 的实时中断能力
- `sandbox` 统一抽象本地和容器执行环境
- 支持 Agent 在上下文增长到阈值前被 Runner 实时打断
- 支持 session resume 或 handoff 文档恢复
- 支持多 Agent Provider
- 支持分支策略
- 支持可组合工作流模板
- 源码文件名、类名、注释和用户可见文案只使用 AFK 自己的概念

## 2. 设计原则

### 2.1 保留现有业务层

以下能力继续属于 AFK 上层，不迁移到 Agent 或 Sandbox：

- GitHub/GitLab Tracker
- Issue labels
- AC 提取和验证
- PR/MR 创建
- QA 阶段
- HITL 状态
- Scheduler / LoopRunner
- Board / Kanban TUI

### 2.2 分离四个概念

```text
Agent Provider       = Agent CLI 差异
Sandbox Provider     = Agent 运行环境差异
Branch Strategy      = Git 分支和 worktree 策略
Workflow Template    = 多步骤业务流程
```

不要形成 Agent、执行环境和业务流程的组合类；使用组合表达：

```text
Claude Code + local sandbox + issue branch + sequential-review template
Codex + docker sandbox + named branch + planner template
```

### 2.3 tmux 不是普通日志容器

`local` 模式必须保留：

- 实时发送 prompt
- 实时发送 interrupt
- 上下文阈值触发 handoff
- session 捕获
- 人工 attach
- HITL 接管

Provider 差异收敛在 Agent Provider 内部。OpenCode 的交互式 TUI 通过启动参数
消费目标（`opencode --auto --prompt …`，TUI 渲染完成后自动提交），因此 local
sandbox 绝不向其 pane 键入 prompt；OpenCode 自行处理启动就绪，完成仍走共享的
`goal_complete` 信号文件。模型选择属于运行时配置（`AFK_OPENCODE_MODEL`，
`provider/model`），产品源码不硬编码默认模型；批处理模式使用
`opencode run --format json`，目标通过 stdin 传入。OpenCode Provider 在启动
TUI 前移除开头的 `/goal` 命令前缀，将完整工作项正文和完成协议作为普通 prompt
传入，避免 OpenCode 自身展开斜杠命令后丢掉多行 prompt 的后续内容。托管 QA
资源保留父级审计 run ID，确保各接管入口定位到同一次执行。

### 2.4 `.afk-signal.json` 逐步退役

不再让 Agent 通过 prompt 主动写控制信号。新的控制协议使用：

- AgentProvider 事件流
- 结构化最终结果
- ExecutionHandle
- AFK runtime 管理的运行状态文件

迁移期间保留旧 signal 兼容读取。

## 3. 目录结构

```text
packages/
├── afk-core/                     # 纯领域：模型、reducer、事件、端口；无 Node/Electron/DOM 依赖
│   └── src/
│       ├── model.ts
│       ├── reducer.ts
│       ├── events.ts
│       ├── ports.ts
│       └── execution-base-policy.ts
│
├── afk-application/              # 用例层：只允许依赖 @afk/core
│   └── src/
│       ├── backlog/
│       ├── tracker/
│       └── work-items/
│
├── afk-infrastructure/           # 基础设施：可依赖 core 与 application
│   └── src/
│       ├── backlog/
│       ├── branches/             # base、issue、named、merge-to-head、existing
│       ├── git/
│       ├── io/
│       ├── observability/
│       ├── provider/
│       ├── shared/
│       └── tracker/
│
├── afk-execution/                # 执行运行时：可依赖 core、application、infrastructure、workflow-graph
│   └── src/
│       ├── application/          # agents、loop、modules、plugins、runtime、sessions、visualizations、workflows
│       ├── domain/               # agents、templates
│       ├── infrastructure/       # config、git、observability、process、runtime、sandbox、tmux
│       ├── observability/
│       └── shared/
│
└── afk-workflow-graph/           # 图引擎：ir、project、normalize、layout、routing、validate、receipt
    └── src/

src/                             # 根层：CLI 与 TUI
├── cli/                         # Commander 装配与命令注册表
├── views/                       # Ink TUI
├── coordinator/
├── plugin-sdk/
├── shared/
└── types/
```

上述五个包根是强制的边界（`pnpm architecture:check --check-packages`）：`core` 不依赖任何包，`application` 只能依赖 `@afk/core`，`infrastructure` 可依赖 core 与 application，`execution` 可依赖 core、application、infrastructure 与 `@afk/workflow-graph`。`WorktreeManager`、`TmuxClient`、`WorkflowRunner`、`HandoffCoordinator` 和 `Watchdog` 通过 adapter 接入 `packages/afk-execution/`。

## 4. 核心接口

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

Provider 能力：

```ts
export type AgentCapability =
  | 'streaming'
  | 'structured-output'
  | 'usage'
  | 'resume'
  | 'fork'
  | 'interactive';
```

首批注册：`claude-code`、`codex`、`cursor`、`pi`、`opencode`、`copilot`。每个 Provider 必须明确声明能力差异，不能假设全部支持 resume、fork 或 structured output。

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

`AgentEvent` 是运行时内部协议，不直接表达 Issue 状态。

### 4.3 SandboxProvider

```ts
export interface SandboxProvider {
  readonly name: SandboxProviderName;
  readonly isolation: IsolationLevel;
  readonly capabilities: ReadonlySet<SandboxCapability>;

  create(options: SandboxOptions): Promise<Sandbox>;
}
```

Provider：`local`、`docker`、`podman`。

隔离等级：

```ts
export type IsolationLevel =
  | 'workspace'
  | 'process'
  | 'filesystem'
  | 'vm';
```

能力：

```ts
export type SandboxCapability =
  | 'streaming-exec'
  | 'interrupt-process'
  | 'kill-process'
  | 'persistent-filesystem'
  | 'copy-files'
  | 'session-transfer';
```

### 4.4 Sandbox 与 AgentExecution

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

`interrupt()` 和 `kill()` 必须区分：

```text
interrupt = 优雅停止，准备 resume/handoff
kill      = 强制结束，不再假设 session 可恢复
```

## 5. Local Sandbox

`LocalSandboxProvider` 将当前 `git worktree + tmux` 组合为统一的本地执行环境：

```text
create
  → 创建/复用 worktree
  → 创建 tmux session
  → 启动 Agent
  → 返回 AgentExecution

interrupt
  → tmux 发送 Ctrl-C
  → 等待 Agent flush
  → capture session
  → 保留 worktree

resume
  → 新 generation tmux session
  → restore session 或读取 handoff
  → 继续执行

close
  → 关闭 tmux
  → close control mode
  → 更新 worktree 状态
  → 按分支策略清理
```

`interrupt()` 不清理 worktree、不删除 session；`close()` 才是最终资源释放。

Local 模式提供任务隔离和实时控制，但不是安全隔离边界：它不能阻止 Agent 访问其他宿主文件、进程或环境变量。

## 6. Container Sandbox

第一版 Docker/Podman 使用 worktree bind mount：

```text
host:
  <repo>/.worktrees/issue-42

container:
  /workspace
```

只挂载：

```text
/workspace
/afk/session
/afk/result
```

不默认挂载：

```text
宿主整个 HOME
~/.ssh
~/.aws
Docker socket
其他仓库
```

默认使用非 root 用户，并通过显式 allowlist 注入环境变量。Agent 进程控制必须保存 container ID、exec ID、Agent PID 和进程组信息；先优雅 interrupt，等待 session flush，超时后再 kill process group，最后才强制终止容器。

第一版采用"一次 workflow 一个 container，每次 context handoff 只重启 Agent process"，保留依赖和缓存，同时保持 generation 边界清晰。

## 7. 上下文交接

上下文交接必须独立于完成判断：

```text
完成判断 ≠ 上下文中断判断
```

流程：

```text
1. Runner 读取 AgentProvider usage/event
2. token 达到 contextHighTokens
3. execution.interrupt()
4. 等待 session flush
5. capture session 并校验完整性
6. 优先原生 session resume
7. resume 不支持或失败时使用 handoff Markdown
8. 启动新 generation
9. 继续当前 workflow step
```

交接恢复文档写入
`<worktree>/.afk/handoff/handoff-<backlogId>-<generation>.md`
（`packages/afk-execution/src/application/workflows/handoff.ts`）。

### 东西分别写在哪里

一次执行会留下三类痕迹，落在三个不同的地方，由三个不同的主人写入。三者不可互换：
一个是权威记录，一个是投影，一个是桌面端自己的暂存空间。

**审计脊柱** —— 一次执行的权威、只追加记录。每个 run 一个 JSONL 文件，带 hash 链，
回放前先校验。

```text
~/.afk/events/<base64url(runId)>.jsonl
```

根目录可由 `AFK_EVENT_STORE_DIR` 改写
（`packages/afk-infrastructure/src/observability/jsonl-event-store.ts`）。

**运行时记录** —— TUI 与桌面端读它来展示进度、心跳与阶段。每个 run 一个文件，
到达终态时从 `active/` 移到 `archive/`。

```text
~/.afk/runtime/tasks/
├── active/<base64url(runId)>.json
├── archive/<base64url(runId)>.json
└── diagnostics/<base64url(runId)>/
    ├── runtime.json
    ├── result.json
    └── output.log
```

（`packages/afk-execution/src/application/runtime/task-runtime.ts`。）

**桌面执行工作区** —— 一个桌面工作项的检出目录、产物与日志。

```text
~/.loop-workspace/<taskId>/
├── repositories/<project>/...
├── artifacts/
├── runtime/
├── logs/
└── diagnostics/
```

（`desktop-client/electron/services/execution-workspace-service.ts`。）

本节此前描述的那棵按 run 的目录树没有了，但它的四个条目并非一起消失——活下来的两个
只是换了位置：

| 原先 | 现在 |
|---|---|
| `<worktree>/.afk/runs/<run-id>/request.json` | 无人写入——产生它的写者只能从它自己的测试到达 |
| `<worktree>/.afk/runs/<run-id>/events.jsonl` | 审计脊柱 `~/.afk/events/<base64url(runId)>.jsonl` |
| `<worktree>/.afk/runs/<run-id>/result.json` | `~/.afk/runtime/tasks/diagnostics/<base64url(runId)>/result.json` |
| `<worktree>/.afk/runs/<run-id>/output.log` | `~/.afk/runtime/tasks/diagnostics/<base64url(runId)>/output.log` |

`result.json` 与 `output.log` 由 `TaskRuntimeStore.writeDiagnostics` 写入，并由运行中心
读取；它们原先所在的那棵树被删除，是因为生产路径上从未有人创建过它。

Session 文件必须使用临时文件、校验和原子 rename，避免新 generation 读取半截 JSONL。

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

新 WorkflowRunner 读取 `ExecutionResult` 推进业务状态。Agent 不再需要主动写控制信号。

迁移期间读取优先级：

```text
1. AgentExecution result
2. result.json
3. 旧 .afk-signal.json
```

## 9. 分支策略

```ts
export type BranchStrategy =
  | { type: 'issue'; iid: number }
  | { type: 'named'; branch: string }
  | { type: 'merge-to-head' }
  | { type: 'existing'; branch: string; worktreePath?: string };
```

策略职责：

- resolve branch name
- prepare worktree
- finalize changes
- merge if required
- cleanup branch/worktree

必须明确：session fork 不等于 branch fork，branch fork 不等于 sandbox fork。并行步骤必须显式使用独立 branch/worktree。

## 10. 工作流模板

模板使用 YAML 描述步骤，prompt 独立存储：

```yaml
name: sequential-review
version: 1

steps:
  - id: implement
    role: implementer
    prompt: prompts/implement.md
    phase: implementation
    completionKind: task
    branch:
      type: issue

  - id: review
    role: reviewer
    prompt: prompts/review.md
    phase: verification
    completionKind: task
    dependsOn:
      - implement

  - id: fix
    role: implementer
    prompt: prompts/fix.md
    phase: implementation
    completionKind: task
    dependsOn:
      - review
    when:
      step: review
      equals: failed
```

`phase` 与 `completionKind` 都是可选的。`phase` 取 `implementation` 或
`verification`，说明这个 step 在工作流行为里处于哪一段：AC 反馈注入到实现阶段的
step，AC 自纠正循环重跑验证阶段的 step。`completionKind` 取 `task`、`qa` 或 `ac`，
说明这个 step 说哪种完成协议。

两者由编译器解析到编译后的 step 上，因此 runner 不再比较 step id。没有声明这两项
的模板仍然可用：阶段与协议由 step 的 `role` 推导。这正是「叫 `verify-ac` 的 step
不再因为名字决定任何事」的原因——名字是数据，声明才是行为。

内置模板：

```text
issue-implementation
pre-merge-qa-verification
simple-loop
sequential-review
parallel-planner
planner-with-review
```

当前 AFK 两阶段 Issue 流程应首先抽成 `issue-implementation` 内置模板：

```text
implement → verify-ac → create-mr → qa
```

模板加载优先级：

```text
CLI 指定路径 → 项目级 .afk/workflows → 用户级 ~/.afk/workflows → 内置模板
```

## 11. 配置与 CLI

CLI 示例：

```bash
afk run --backlog-id <id>
```

`afk run` 认领一个 ready 状态的 backlog 项，并按该项选定的模板推进执行。模板由
`packages/afk-execution/src/domain/templates/builtin.ts` 解析，可用
`--template <name>` 覆盖；相关选项还有 `--agent`、`--sandbox`、
`--execution-mode`、`--base-branch`、`--target-branch`、`--max-handoffs`、
`--context-high`、`--max-total-tokens` 与 `--hard-timeout`。不存在 `afk workflow`
命令组，也没有 `--iid` 或 `--branch-strategy` 选项——工作项用 `--backlog-id` 选择，
分支用 `--base-branch` 选择。

配置示例：

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

配置优先级：CLI → `.afk/config.yml` → 环境变量 → 默认值。

## 12. 分阶段开发计划

### 阶段 0：基线与接口设计

- 固定当前测试基线
- 建立 Agent、Sandbox、Execution、Session、Branch、Template 类型
- 不改变现有运行行为

验收：`pnpm build`、`pnpm test` 通过。

### 阶段 1：Local Sandbox 兼容接入

- 实现 `LocalSandboxProvider`
- 封装现有 `WorktreeManager` 和 `TmuxClient`
- 将 `WorkflowRunner` 改为依赖 Sandbox/Execution 接口
- 保留现有 context handoff、watchdog 和 HITL

验收：现有 tmux workflow 行为不变；运行中 context threshold 能触发 interrupt 和 handoff。

### 阶段 2：事件流与结果协议

- 实现 `AgentEvent`
- 实现 `ExecutionResult`
- 新增 run 状态目录
- Agent 结果优先走结构化协议
- 保留 `.afk-signal.json` fallback

验收：结构化完成、失败、阻塞、超时和非法结果均有测试。

### 阶段 3：多 Agent Provider

一次性建立并注册：

- Claude Code
- Codex
- Cursor
- Pi
- OpenCode
- Copilot

每个 Provider 实现独立 command builder、stream parser 和 capability matrix。

验收：每个 Provider 有 fixture 测试；不支持 resume 的 Provider 不得被错误地进入 resume 流程。

### 阶段 4：Session Store 与交接增强

- 实现 provider-specific session store
- 优先原生 resume
- 失败时 fallback 到 handoff Markdown
- 保存 generation、checksum 和恢复元数据

验收：上下文超限后的新 generation 能继续当前阶段；session 损坏时能安全降级。

### 阶段 5：Docker/Podman Sandbox

- 实现容器创建和清理
- worktree bind mount
- 非 root 用户
- 环境变量 allowlist
- streaming exec
- process group interrupt/kill
- 同一 container 内 generation 重启

验收：容器内 Agent 能修改宿主 worktree；context handoff、失败清理和容器回收正常。

### 阶段 6：Branch Strategy

- `issue`
- `named`
- `merge-to-head`
- `existing`

验收：每种策略均有 Git fixture/integration test；并行 workflow 不共享可写 branch/worktree。

### 阶段 7：Workflow Template

- 实现模板 schema、loader、registry
- 将现有流程抽成 `issue-implementation`
- 增加 `simple-loop`
- 增加 `sequential-review`
- 增加 `parallel-planner`
- 增加 `planner-with-review`

验收：模板能表达依赖、条件、执行模式、Agent、分支策略和结构化输出。

### 阶段 8：移除旧 signal 协议 ✅

前提：所有新 workflow 和默认 Provider 已使用 ExecutionResult。

- ✅ 删除新 prompt 中的 signal 写入要求 (`packages/afk-execution/src/domain/templates/builtin.ts` 与工作流阶段)
- ✅ Runner 仍读取 signal 作为向后兼容 fallback (`packages/afk-execution/src/infrastructure/tmux/tmux.ts`)
- ⏳ 清理 legacy signal CLI/schema/tests（保留 readSignal/writeSignal/clearSignal + 单元测试；CLI/技能暂无独立 signal 子命令）
- ✅ 更新 skills、README 和架构文档（`CLAUDE.md` 含 Phase 状态表）

验收：全量测试通过，旧 worktree 可以被兼容读取或明确迁移。

实现细节：
- 批量 agent 通过 `ExecutionResult` 上报；交互式 agent 按 `packages/afk-execution/src/application/workflows/execution-protocol.ts` 写 `.afk-signal.json`，由 `packages/afk-execution/src/infrastructure/tmux/tmux.ts` 的 `readSignal`/`readSignalSync` 读取。
- `packages/afk-infrastructure/src/io/signal.ts` 持有 signal 文件原语。

## 13. 测试计划

### 单元测试

覆盖：

- Provider command 构造
- stream event 解析
- usage 聚合
- capability 检测
- invalid result
- interrupt/kill 区分
- session capture/restore
- branch strategy
- template dependency resolution

### Local Sandbox 集成测试

使用 fake Agent process 验证：

- context threshold interrupt
- handoff 后 resume
- timeout
- manual abort
- tmux cleanup
- worktree 保留

### Docker/Podman 集成测试

在运行环境可用时验证：

- worktree mount
- 环境变量白名单
- 非 root 用户
- process interrupt
- 子进程 cleanup
- session transfer
- container cleanup

### 端到端测试

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

## 14. 文档同步

需要同步：

- `README.md`
- `CLAUDE.md`
- `docs/architecture/overview.md`
- `docs/guides/workflows.md`
- `docs/getting-started.md`
- `docs/guides/testing.md`
- `docs/guides/skills.md`

文档必须说明：

1. `local` 是任务隔离，不是安全隔离
2. Docker/Podman 的挂载边界
3. Agent Provider 能力差异
4. context handoff 的实时中断流程
5. branch strategy
6. workflow template
7. session resume 和 handoff fallback
8. `.afk-signal.json` 的迁移状态

同时修正现有架构文档中的实现漂移：

- Scheduler 实际是内存队列，不是 BullMQ/Redis
- AC 验证文档需要与当前 WorkflowRunner 实际流程一致
- 默认 timeout 以 `afk run` 的 `--hard-timeout` 选项为准（`src/cli/commands/run.ts`）

## 15. 最终架构

```text
afk run --backlog-id <id>
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

最终职责：

- `Worktree`：代码和 branch 隔离
- `Sandbox`：Agent 执行环境
- `ExecutionHandle`：实时输出、中断、恢复
- `AgentProvider`：不同 Agent CLI 的适配
- `SessionStore`：上下文交接
- `BranchStrategy`：分支和 worktree 生命周期
- `WorkflowTemplate`：多步骤流程定义
- `WorkflowRunner`：Issue 业务状态和整体编排
