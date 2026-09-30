# Core 层与多端复用架构

## 目标

AFK 同时提供 CLI、TUI、Electron Desktop 和插件能力。它们应复用同一套
工作项、运行、状态转换和执行策略，而不是分别维护业务模型和状态规则。

本设计的目标是：

- 将稳定的业务规则抽象为独立的 `core` 层。
- 让 CLI 和 Desktop 通过相同的应用用例访问业务能力。
- 将 GitHub、GitLab、Git、Codex、tmux、文件系统和 Electron 隔离在适配层。
- 保持跨进程 DTO 与内部业务模型边界清晰。
- 通过编译依赖和架构检查防止边界逐渐失控。

本设计按边界分批实施，但每个已迁移入口只保留新架构，不保留旧实现回退。

## 当前落地状态

当前已落地：

- `packages/afk-core` 提供独立的 `@afk/core` workspace package。
- `packages/afk-application` 提供 inventory、run decision/start 和 observation/query
  的最小用例 facade。
- CLI `observe executions` 直接调用 `@afk/application` 的
  `queryExecutionHistory`，CLI 只负责参数解析和输出。
- Workflow 运行入口显式组装 `RunObserver` 并注入 `WorkflowRunner`；审计事件写入
  失败即停止执行，已删除 `legacy-observer` 与 `AFK_HARNESS_MODE` 分支。
- Desktop inventory 通过 `@afk/application/provider-inventory` Port 调用进程内
  GitHub/GitLab Provider；执行历史通过只读事件 Port 调用
  `@afk/application.queryExecutionHistory`，不再调用 CLI 子进程。
- Loop 只调度单项 manifest 并调用 `executeWorkItem`，旧 WorkflowRunner→QARunner
  双执行链与 QA 队列已删除；缺失 manifest 时明确拒绝启动。
- 架构守卫现在检查 Core/Application package 的依赖纯度和 package 边界。
- backlog 到 core 的状态与执行模式映射收敛为单一实现
  `packages/afk-application/src/backlog-mapping.ts`，CLI 与 Desktop 共用，
  不再各维护一份映射表。Desktop 经既有 esbuild 产物
  `dist-electron/application.cjs` 以值的方式调用，未新增构建变体。

仍需继续收敛根包 `src/application` 中的 Provider SDK 实现、其他 Desktop CLI
入口和工作项状态转换；不能将已迁移入口的单路径误写成全仓所有能力迁移完成。
Desktop 目前对 `@afk/core` 的引用仍限于 `import type`，`decide` / `evolve` /
`replay` / `resolveExecutionBase` 尚未在 Desktop 侧被调用——本节完成的是状态
映射的去重，Core 行为函数的多端共享尚未达成。

## 当前结构分析

### 已有基础

核心模型现在位于独立的 `packages/afk-core`：

- `src/model.ts` 定义 `WorkItem`、`Run`、状态和运行决策。
- `src/reducer.ts` 负责运行事件回放和状态演进。
- `src/events.ts` 定义运行事件、观察上下文和证据引用。
- `src/ports.ts` 定义事件存储、证据存储、时钟、ID、指标和追踪 Port。
- `src/execution-base-policy.ts` 负责执行基线策略。

这些模块大体是纯 TypeScript，已经具备核心层的基本形态。

### 当前边界问题

#### Core 的迁移边界

`packages/afk-core` 已成为正式 workspace package；根包不再维护第二份模型、
事件、Reducer 或 Policy 实现。

#### Domain 层职责过重

`src/domain/backlog` 同时包含：

- backlog 领域类型；
- Provider 接口；
- Provider 管理能力；
- Claim 和文件系统锁；
- 内存 Provider；
- 标签与分支映射规则。

这些内容分别属于核心规则、应用接口和基础设施实现，不应长期放在同一层。

#### Application 层包含基础设施组装

部分 `src/application` 模块直接创建或引用 Git、tmux、配置、日志和 Provider
实现。这样 application 层既负责业务编排，又负责运行环境组装，CLI 和 Desktop
难以共享同一套用例。

#### Desktop 的跨进程 DTO 仍是独立边界

Desktop 的 Main 通过 Application adapter 获取工作项数据，并在
`desktop-client/shared` 中维护跨进程 DTO。DTO 是必要的传输边界，不是第二套
业务规则。当前 Desktop inventory 的 Provider SDK 在 Main 进程内运行，
通过 Application Port 注入；查询也直接读取经校验的事件流。Provider 细节
不能泄漏到 service、IPC 或 renderer，否则会产生：

- CLI 输出协议和 Desktop contract 双重演进；
- CLI 子进程启动、路径、超时和版本检测成为业务流程的一部分；
- Desktop 无法直接复用 Core 的状态转换和执行策略；
- 同一个领域概念在根包和 Desktop 中存在两套类型定义。

#### 架构守卫持续保护 Core

架构检查同时扫描 `@afk/core`、`@afk/application` package 和根包层之间的
依赖，阻止 Core 依赖 application、infrastructure、Electron 或其他运行时实现。

## 目标结构

第一阶段保留现有根目录布局，只新增可复用 package：

```text
packages/
  afk-core/
    src/
      work-item/
      run/
      lifecycle/
      policy/
      events/
      ports/
      index.ts

  afk-application/
    src/
      backlog/
      execution/
      observation/
      workflow/
      index.ts

src/
  infrastructure/
    github/
    gitlab/
    git/
    sandbox/
    observability/
    process/

  cli/
    commands/
    presentation/
    composition-root.ts

desktop-client/
  electron/
    adapters/
    services/
    ipc/
    composition-root.ts
  shared/
    ipc-contracts/
  src/
    features/
```

`packages/afk-core` 和 `packages/afk-application` 都应是 workspace package，
采用仓库中 `packages/afk-workflow-graph` 已使用的 package 构建方式。

## 分层职责

### `@afk/core`

Core 是业务内核，不是公共工具箱，也不是基础设施集合。

Core 负责：

- `WorkItem`、`Run`、Lineage 和运行状态；
- 状态转换、依赖判断和可执行性策略；
- 运行命令、领域事件、Reducer 和回放；
- 证据、观察上下文和事件存储等 Port；
- 不依赖环境的纯业务函数。

Core 禁止依赖：

- Node.js、Electron、React 和 DOM；
- 文件系统、子进程、网络和数据库；
- GitHub、GitLab、Git、tmux、Codex 等具体实现；
- Commander、Ink、IPC channel 和 CLI 参数；
- Provider 标签字符串或平台客户端。

`src/application/backlog-work-item.ts` 中把外部 backlog 模型映射为 Core 模型的逻辑
属于 adapter/application 边界，不应让 Core 依赖 `BacklogWorkItemInput`、`afk`
或 `hitl` 这样的外部命名。

### `@afk/application`

Application 提供可被 CLI 和 Desktop 调用的业务用例，例如：

- `listWorkItems`；
- `getWorkItem`；
- `startRun`；
- `observeRun`；
- `executeWorkItem`；
- `transitionBacklog`；
- `queryExecutionHistory`。

Application 只依赖 Core 的模型和 Port。所有 Provider、EventStore、Agent、
Workspace 和日志实现都通过构造参数注入。

Application 不负责：

- 读取环境变量；
- 创建 GitHub/GitLab client；
- 解析 Commander 参数；
- 访问 Electron API；
- 直接打开文件或启动进程。

### Infrastructure

Infrastructure 实现 Core/Application 所需的 Port，包括：

- GitHub、GitLab 和未来的其他 tracker Provider；
- Git 分支、worktree 和变更请求；
- Codex、Claude、Copilot、sandbox 和 agent runtime；
- tmux、子进程和 PTY；
- JSONL、文件系统、SQLite 和证据存储；
- 配置、日志、指标和追踪。

Infrastructure 可以依赖 Core 的 Port 和领域类型，但 Core 不能反向依赖它。

### CLI

CLI 是表现层和 composition root，负责：

- Commander 命令注册；
- 参数解析和错误码；
- JSON、表格、TUI 和终端输出；
- 读取 CLI 配置；
- 组装 application、Provider 和 infrastructure。

CLI 命令不实现工作项状态转换和执行资格判断。

### Desktop

Electron Main 是 Desktop 的 composition root 和安全边界，负责：

- 组装 application 和 infrastructure；
- 注册 IPC handler；
- 校验 IPC 输入和 sender origin；
- 将 application 结果投影为 IPC DTO；
- 管理文件、进程、SSH、PTY 和 Electron API。

Renderer 只依赖 preload 暴露的固定 API 和 `shared` IPC contract，不访问 Node.js、
Electron 或本地文件系统。

## 依赖规则

目标依赖方向如下：

```text
core             -> no business dependency
application      -> core
infrastructure   -> core + application ports
cli              -> application + infrastructure + contracts
desktop main     -> application + infrastructure + contracts
desktop renderer -> preload API + IPC contracts
```

禁止以下依赖：

```text
core             -> application / infrastructure / cli / desktop
application      -> concrete infrastructure implementation
renderer         -> Node.js / Electron / filesystem
shared contract  -> core runtime / Node.js / Electron / React
```

`shared` 只保存真正跨边界的 DTO 和校验，不作为无法归类代码的临时目录。

## Core、Application 和 IPC 模型的边界

三类模型应明确区分：

### Core model

表达业务事实和业务状态，例如：

- `WorkItem`；
- `Run`；
- `RunStatus`；
- `WorkState`；
- `RunEvent`。

Core model 不包含 UI 文案、Electron 字段或 Provider 原始响应。

### Application result

表达一个用例的结果，例如：

- 工作项列表及诊断；
- 启动运行的结果；
- 执行历史查询结果；
- Provider 部分失败时的可重试诊断。

Application result 可以包含 Core model，但应负责组合多个 Port 的结果。

### IPC contract

表达跨 Electron Main/Renderer 的稳定传输格式。IPC DTO 可以是 Application result
的投影，但不能在 Renderer 中重新实现 Core 规则。

## Desktop 的长期调用路径

Desktop 本地运行时的主路径应为：

```text
React renderer
  -> preload fixed API
    -> IPC handler
      -> application use case
        -> core policy / reducer
        -> injected infrastructure ports
      -> IPC DTO
  -> React view model
```

Provider SDK 位于 Main 进程 adapter，Application 用例只依赖 Port；不再通过
Desktop inventory 或执行历史查询调用 CLI，也没有 service 回退路径。

## 分阶段迁移计划

### 阶段一：提取 Core package

- 新建 `packages/afk-core`。
- 将纯模型、事件、Reducer、Policy 和 Port 放入 `packages/afk-core`。
- 根包调用方直接依赖 `@afk/core`，不再维护根包 Core 门面。
- 为 package 增加独立 typecheck、build 和 test。
- 将架构守卫加入 `core` layer。

### 阶段二：收敛领域模型

- 将稳定的 WorkItem、Run、依赖和状态规则移入 `@afk/core`。
- 将外部 backlog 到 Core 的映射移至 adapter/application。
- 将 `domain/backlog` 中的 Provider 实现、Claim lock 和平台标签解析移出核心域。
- 保留现有 Provider 行为，先调整依赖方向，不改变业务语义。

### 阶段三：提取 Application facade

- 新建 `@afk/application`。
- 先抽取 backlog inventory、run start、run observation 三条用例。
- 删除对应入口的旧 service、兼容 adapter 和 fallback 分支，不做双路径运行。
- 将基础设施实例创建移到 CLI 和 Desktop 的 composition root。
- Application 仅接收 Port 和配置对象，不读取全局环境。

### 阶段四：迁移 CLI

- CLI 命令改为调用 application facade。
- Provider 和 infrastructure 只在 CLI 入口组装。
- CLI JSON 输出直接使用 Application result，不再经过旧查询模型转换。

### 阶段五：迁移 Desktop

- Electron Main 直接组装 application 和 infrastructure。
- Backlog、Work Item、Run 查询逐步移除 CLI 子进程依赖。
- 删除 Desktop 中重复的业务状态转换和 Provider 规则。
- IPC contract 只保留跨进程所需的字段。

## 架构守卫与验收标准

架构守卫需要至少覆盖以下规则：

- `core` 不得导入 application、infrastructure、CLI 或 Desktop。
- `application` 不得导入具体 infrastructure 实现。
- Desktop renderer 不得导入 Node.js、Electron 或本地 I/O。
- IPC contract 不得依赖 Electron、Node.js、React 或 DOM。
- 新增 Provider 实现不得被 Core 或 Application 直接引用。
- 每个 extracted service 和 pure function 都有独立测试。
- Core、Application 和 Desktop package 分别具备 typecheck、build 和 test。

最小验收结果是：同一个 backlog 在 CLI 和 Desktop 中经过同一套 Core 状态规则，
不会因为入口不同产生不同的可执行性、状态转换或运行事件语义。

## 非目标

本设计暂不要求：

- 一次性将整个仓库改成完整 monorepo app/package 结构；
- 将所有 `shared` 类型都合并进 Core；
- 引入数据库、中间件或新的远程服务；
- 让 Renderer 直接持有完整 Core 聚合对象。

优先完成 Core、Application、CLI 和 Desktop 之间的依赖收敛，再处理目录重命名和
历史模块拆分。
