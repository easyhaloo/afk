# AFK 执行架构

本文描述的是**当前实现**，不是目标态或尚未落地的多 Agent 执行蓝图。完整状态与证据约定请参考[架构概览](overview.zh.md)及[全流程执行与 E2E 验证架构](full-workflow-e2e-architecture.md)。

## 系统边界

AFK 执行已经存在、且由上游完成拆分的 Provider-backed 工作项。AFK 本身不充当全局规划器，也不负责将需求拆成任务。外部 Issue Tracker 是 backlog 状态的权威来源；本地 manifest、执行日志、运行事件和证据用于支撑执行与审计。

## Workspace 包边界

| 包 / 应用 | 职责 |
|---|---|
| `@afk/core`（`packages/core`） | 纯领域模型、事件、reducer、策略和端口 |
| `@afk/application`（`packages/application`） | 共享用例、清单与执行查询 |
| `@afk/runtime`（`packages/runtime`） | Provider 集成、backlog 操作、工作流执行、Agent/Sandbox 适配器、Git、tmux 与持久化 |
| `@afk/workflow-graph`（`packages/workflow-graph`） | 纯工作流图表示、投影、布局、路由和校验 |
| CLI/TUI（`apps/cli`） | 命令行入口与终端交互界面 |
| Desktop（`apps/desktop`） | Electron main/preload 与 React renderer；通过校验后的 IPC 和独立 Runtime worker 执行受管工作项 |

应用通过声明的 package exports 使用共享包；共享包不得依赖应用。Desktop renderer 不得直接访问 Node Runtime，Node 能力必须经主进程提供。包边界与导入方向由架构检查约束。

## 执行入口

- `afk`：打开交互式 TUI。
- `afk run`：执行工作项的实现阶段。
- `afk execute --work-item-id <id>`：执行受管生命周期，包括资格与 manifest 校验、实现、独立 QA、变更请求处理，以及由人控制的合并闸门。
- `afk loop start`：针对一个绑定 manifest 的工作项持续尝试，并委托给同一受管执行路径；它不是全局多工作项调度器。
- `afk qa`：在适用场景下独立运行 QA。
- `afk observe`：查看执行记录及其审计、证据投影。

完整命令面以 `apps/cli/src/command-registry.ts` 为准，不应从旧示例或历史计划推断当前支持的命令。

## 数据与工作区边界

- AFK 配置和系统数据位于 `~/.afk/`。
- 执行工作区位于 `~/.loop-workspace/`。
- 每个工作区的 manifest、启动回执、session、诊断运行和执行日志位于 `~/.afk/workspaces/` 下以工作区路径计算的哈希目录中。
- 仓库 checkout 位于规范执行工作区内；调用者的当前目录不会改变规范执行根目录。
- Agent 完成信号和 QA artifact manifest 是执行期协议文件，不是通用配置或生命周期状态存储。

精确路径及解析规则见[架构概览：执行与系统数据路径](overview.zh.md#执行与系统数据路径)。

## 受管执行生命周期

受管执行会校验工作项及其 manifest，运行实现阶段，记录分支和运行证据，执行独立 QA，并准备或验证 Provider-backed 变更请求。单次执行成功不等于代码已经合并。最终合并由人控制；只有合并完成并经 reconcile 确认后，工作项才进入终态完成状态。

Provider backlog、Runtime 状态、run-event 审计轨迹和证据属于不同权威范围：

- Provider 状态是 backlog 与变更请求状态的权威来源。
- Runtime 状态记录执行尝试及其生命周期。
- append-only 运行事件支持审计和重放。
- Evidence 引用及分类支持 QA、诊断和脱敏策略。

## 失败与恢复

当身份、manifest、claim 或验证证据缺失或无效时，执行必须 fail closed。恢复和 reconcile 应基于已有工作项身份及记录状态；reconcile 不能代替创建新的执行 manifest。若 Agent 无响应或验证无法运行，系统应保留证据并暴露可恢复状态，而不是将任务误判为完成。

## 相关文档

- [全流程执行与 E2E 验证架构](full-workflow-e2e-architecture.md)
- [可观测性与证据](observability.md)
- [架构决策记录](../adr/README.md)
