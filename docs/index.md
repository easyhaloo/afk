# AFK 文档导航

本目录以当前实现、使用指南和架构决策为主。仓库根的 `README.md` / `README.zh.md` 是项目入口；本页负责深入文档导航。

## 从这里开始

| 读者目标 | 文档 |
|---|---|
| 安装与首次使用 | [Getting Started (EN)](getting-started.md) · [快速开始（中文）](getting-started.zh.md) |
| 理解当前系统边界与包职责 | [Architecture Overview](architecture/overview.md) · [架构概览（中文）](architecture/overview.zh.md) |
| 跟踪一次工作项的完整执行、QA、证据和人工合并闸门 | [Full Workflow & E2E Architecture](architecture/full-workflow-e2e-architecture.md) |
| 理解架构原则与取舍 | [系统架构设计说明书](architecture/system-architecture-design.md) |
| 使用 CLI、Desktop 与 Skills 工作流 | [Workflows (EN)](guides/workflows.md) · [工作流（中文）](guides/workflows.zh.md) |
| 编写或运行测试 | [Testing (EN)](guides/testing.md) · [测试指南（中文）](guides/testing.zh.md) |
| 使用与理解 Skills | [Skills Guide (EN)](guides/skills.md) · [Skills 指南（中文）](guides/skills.zh.md) |

## 当前架构说明

| 文档 | 职责与权威范围 |
|---|---|
| [architecture/overview.md](architecture/overview.md) | 系统边界、workspace 包职责、数据权威、工作项关系、生命周期与关键架构约束；不承担完整 CLI 参考或逐步执行手册 |
| [architecture/full-workflow-e2e-architecture.md](architecture/full-workflow-e2e-architecture.md) | 当前实现中的 run / execute / loop、模板、QA、状态转换、证据和 E2E 验证细节 |
| [architecture/execution.md](architecture/execution.md) | 执行入口、运行目录、托管生命周期和恢复原则摘要；英文版本 |
| [architecture/execution.zh.md](architecture/execution.zh.md) | 执行入口、运行目录、托管生命周期和恢复原则摘要；中文版 |
| [architecture/observability.md](architecture/observability.md) | 运行事件、审计链、证据与诊断 |
| [architecture/design-system.md](architecture/design-system.md) | Desktop UI 设计标准 |
| [architecture/glossary.md](architecture/glossary.md) | 领域术语 |
| [architecture/diagrams/](architecture/diagrams/README.zh.md) | 架构图源文件及说明 |

## 指南（guides/）

| 文档 | 内容 |
|---|---|
| [guides/workflows.md](guides/workflows.md) | 当前 CLI / Desktop 工作项执行路径与人工控制边界 |
| [guides/skills.md](guides/skills.md) | Skills 分类、职责边界、调用与协作 |
| [guides/testing.md](guides/testing.md) | CLI/TUI、共享包、Desktop 与 E2E 测试入口 |
| [guides/agent-plugins.md](guides/agent-plugins.md) | Agent 插件兼容与集成说明 |

## 架构决策记录（adr/）

ADR 记录已经作出的架构决策，不替代当前实现说明。

| 编号 | 标题 | 状态 |
|---|---|---|
| [0001](adr/0001-desktop-deferred-and-declined-refactors.md) | Desktop 端延后与拒绝的重构 | accepted |
| [0014](adr/0014-interactive-and-batch-structured-output.md) | Interactive and batch structured output | accepted |
| [0015](adr/0015-typed-workflow-runtime.md) | Typed workflow runtime | accepted |
| [0016](adr/0016-run-event-audit-spine.md) | Run Event Audit Spine | accepted |
| [0017](adr/0017-capability-profiles-and-ports.md) | Capability profiles and ports | accepted |
| [0018](adr/0018-evidence-classification-and-redaction.md) | Evidence classification and redaction | accepted |
| [0019](adr/0019-desktop-run-log-viewer-projection.md) | Desktop run log viewer projection | in progress |
| [0020](adr/0020-backlog-item-drop-singular-change-request.md) | Backlog item drop as singular change request | accepted |
| [0021](adr/0021-backlog-relation-carrying.md) | Backlog 关系的承载方式与记录可读性 | accepted |
| [0022](adr/0022-execution-plan-and-repository-leases.md) | Execution plans and repository leases | accepted |
| [0023](adr/0023-repository-store-and-dependency-pool.md) | Repository store and dependency pool | accepted |
| [0024](adr/0024-prd-baseline-branches.md) | PRD baseline branches | accepted |
| [0025](adr/0025-structured-failure-diagnostics.md) | Structured failure diagnostics | proposed |
| [0026](adr/0026-goal-condition-budget-and-worktree-context.md) | The goal condition budget, and context in the worktree | accepted |
| [0027](adr/0027-scheduler-timer-re-evaluation-and-wait-reasons.md) | The scheduler re-evaluates on a timer, and says why it waits | accepted |
| [0028](adr/0028-rework-attempt-budget-per-cycle.md) | The QA rework budget belongs to a cycle, not to the item's life | accepted |
| [0029](adr/0029-worktree-claim-lifetime.md) | A worktree claim belongs to the attempt that took it | accepted |
| [0030](adr/0030-afk-worktrees-are-invisible.md) | AFK's own worktrees are invisible to the user's repository | accepted |
| [0031](adr/0031-publish-boundary.md) | The target branch belongs to AFK's change request | accepted |
| [0032](adr/0032-provider-and-runtime-are-one-decision.md) | A provider and the runtime that runs it are one decision | accepted |
| [0033](adr/0033-agent-tui-modals.md) | A modal in the agent's TUI belongs to AFK to dismiss | accepted |

## 保留的研究材料（research/）

研究报告仅作为阶段性参考，不作为当前架构或实现事实的唯一依据。保留与 AFK 编码 Agent 工具选型直接相关的中英对照研究；其他一次性调研、已被当前实现取代的设计材料及重复格式已移除。

- [Agent CLI comparison (EN)](research/agent-cli-comparison.md) · [中文版本](research/agent-cli-comparison.zh.md) — 2026-10-20 工具版本快照，结论使用前需重新验证。

## 文档维护与归档

- `_archive/` 保存已完成的实现计划、旧设计规格、原型和调研快照，不作为现行规范。归档材料仅用于追溯历史决策。

## 文档维护约定

- 当前行为以源码、CLI 命令注册表、架构守卫和测试为准；文档不能覆盖实现事实。
- 已实现的架构能力应写入当前架构说明；已否决或被替代的方案应明确标注或归档。
- PRD 文档不存放在 `docs/` 中；本目录不维护产品需求文档集合。
- 修改文件路径、命令、包边界或运行行为时，同步更新对应文档及其双语版本。
