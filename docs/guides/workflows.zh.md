# AFK 工作流

本文描述已经落地的工作项生命周期。示例与实现不一致时，以源码和命令注册表为准。

## 职责边界

AFK 消费已经存在、具有明确范围、验收标准和依赖关系的 Provider-backed 工作项。需求澄清和任务拆分由上游完成；AFK 不会在执行期间创建全局计划或将一个需求自动拆成多项任务。

外部 Issue Tracker 是 backlog 状态的权威来源。AFK 的本地 manifest 和 Runtime 记录负责执行身份、隔离、审计与恢复。

## 选择执行入口

| 入口 | 适用场景 | 边界 |
|---|---|---|
| `afk` | 交互式 CLI/TUI 操作 | 打开终端界面 |
| `afk run` | 携带 CLI 运行参数执行完整受管流程 | 包含实现、独立 QA 和发布，停在人工合并闸门 |
| `afk execute --work-item-id <id>` | 受管执行一个工作项 | 校验资格与 manifest，运行实现和独立 QA，准备/验证变更请求，并停在人工合并闸门 |
| `afk loop start` | 对一个绑定 manifest 的工作项重复尝试 | 委托给 `executeWorkItem`；不是全局多工作项队列 |
| `afk qa` | 独立验证 | 适用于需要单独运行 QA 的场景 |
| `afk observe` | 查看运行与证据 | Runtime / 审计投影的观察入口 |

安装和配置见[快速开始](../getting-started.zh.md)，完整命令面见[架构概览](../architecture/overview.zh.md)。

## 受管生命周期

1. **解析身份与资格。** 确定 Provider-backed 工作项并解析其执行 manifest。身份缺失或状态无效时，不得静默切换到其他任务。
2. **准备隔离工作区。** 使用规范执行根目录和 repository checkout；不要假定当前 shell 目录决定工作区。
3. **实现。** 选定的 Agent Provider 在准备好的执行环境中实施变更。
4. **独立验证。** QA 独立评估验收标准，并记录证据，不能只复述实现阶段的自我声明。
5. **准备或验证变更请求。** 按实际状态发布实现分支，并创建或 reconcile Provider-backed 变更请求。
6. **停在人工合并闸门。** AFK 不会自动合并代码。只有人完成合并后，系统才 reconcile 外部 Provider 状态。

`afk run` 与 `afk execute` 共享受管生命周期，成功包含独立 QA 与确认发布；条目到达 `done` 仍需人工合并与 reconcile。多条目编排使用 `afk schedule --parent <规范身份>`，磁盘画像使用只读的 `afk doctor --json`。

## CLI 与 Desktop

CLI 与 Desktop 共享 Runtime 用例。Desktop 的受管执行运行在独立 Node worker 中，因此可以在 renderer 窗口关闭后继续执行。Desktop renderer 通过校验后的 IPC 访问主进程，不得直接导入 Runtime。Work Items 视图负责启动或重试受管工作项，Run Center 展示相应的审计运行记录。

## 状态、证据与恢复

以下是职责不同的投影：

- **Provider backlog / 变更请求：** 外部业务状态。
- **Runtime 生命周期：** 当前执行尝试及恢复状态。
- **Run events：** append-only 审计历史与重放输入。
- **Evidence：** 支持 QA、诊断和报告的分类证据引用。

Agent 无响应、无法运行验证或缺少必要证据时，应保留失败状态和证据。不能仅凭进程退出或实现阶段成功就判定完成。恢复与 reconcile 必须保留相同的工作项身份。

## Skills 集成

Skills 提供 Agent 侧的需求澄清、研究、PRD 编写、Issue 拆分、实现、测试、QA、交接和知识管理工作流，但不会替代 AFK Runtime 生命周期或 Provider 状态。职责边界见[Skills 指南](skills.zh.md)。

## 相关文档

- [全流程执行与 E2E 验证架构](../architecture/full-workflow-e2e-architecture.md)
- [执行架构](../architecture/execution.zh.md)
- [可观测性](../architecture/observability.md)
