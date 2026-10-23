# AFK 文档导航

按读者 × 生命周期组织。仓库根的 `README.md` / `CLAUDE.md` 仍然是入口。

## 架构（architecture/）

| 文档 | 说明 |
|---|---|
| [system-architecture-design.md](architecture/system-architecture-design.md) | **系统架构设计说明书**：边界、约束、分层、闭环、不变量、失败模型与演进 |
| [overview.md](architecture/overview.md) | AFK 跨平台抽象与 CLI 命令映射 |
| [execution.md](architecture/execution.md) | 8 阶段执行设计（执行环境、sandbox、session、branches、templates） |
| [observability.md](architecture/observability.md) | 可观测性 harness |
| [design-system.md](architecture/design-system.md) | Desktop 设计标准 |
| [glossary.md](architecture/glossary.md) | 领域词汇表（原仓库根 `CONTEXT.md`） |
| [full-workflow-e2e-architecture.md](architecture/full-workflow-e2e-architecture.md) | 任务派发、Loop、模板与 QA 闭环的 E2E 架构和证据规范 |
| [blueprints/](architecture/blueprints/) | 蓝图与未采纳方案（草稿） |

## 指南（guides/）

| 文档 | 说明 |
|---|---|
| [workflows.md](guides/workflows.md) | Issue → MR 流程、调度器、Skills 集成 |
| [skills.md](guides/skills.md) | Skills 设计与使用 |
| [testing.md](guides/testing.md) | TUI 与单元测试 |

## ADR（adr/）

按编号递增排序。Desktop 端 ADR 带 `desktop-` 前缀。

| 编号 | 标题 | 状态 |
|---|---|---|
| [0001-desktop-...](adr/0001-desktop-deferred-and-declined-refactors.md) | Desktop 端延后与拒绝的重构 | accepted |
| [0014](adr/0014-interactive-and-batch-structured-output.md) | Interactive and batch structured output | accepted |
| [0015](adr/0015-typed-workflow-runtime.md) | Typed workflow runtime | accepted |
| [0016](adr/0016-run-event-audit-spine.md) | Run Event Audit Spine | accepted |
| [0017](adr/0017-capability-profiles-and-ports.md) | Capability profiles and ports | accepted |
| [0018](adr/0018-evidence-classification-and-redaction.md) | Evidence classification and redaction | accepted |
| [0019](adr/0019-desktop-run-log-viewer-projection.md) | Shared execution views and interactive tmux access | in progress |

## 产品与研究

| 路径 | 内容 |
|---|---|
| [product/PRD.md](product/PRD.md) | 产品需求文档 |
| [product/PRD-retro-feedback-loop.md](product/PRD-retro-feedback-loop.md) | AFK 执行复盘反馈闭环 PRD |
| [product/PRD-work-items-reverse-sort-2026-10-15.md](product/PRD-work-items-reverse-sort-2026-10-15.md) | 全局工作项倒序筛选 |
| [research/](research/) | 研究材料与方法论文档 |
| [research/observability-survey-2026-08-02.md](research/observability-survey-2026-08-02.md) | 可观测性 harness 调研与历史基线 |

## 文档治理

| 路径 | 内容 |
|---|---|
| [superpowers/plans/2026-10-20-outdated-docs-cleanup-plan.md](superpowers/plans/2026-10-20-outdated-docs-cleanup-plan.md) | 过时文档盘点与清理计划（分级处置清单、时序与验收标准） |

## 归档

`_archive/` 下保留历史材料，不在主文档流中：

| 路径 | 内容 |
|---|---|
| `_archive/prototype/` | 历史 UI 原型（HTML / PNG） |
| `_archive/design-demos/` | 历史 design demo 与截图 |
| `_archive/superpowers/plans/` | 过去的实施计划 |
| `_archive/superpowers/specs/` | 过去的设计规格 |

## 可观测性 profile 示例

| 路径 | 内容 |
|---|---|
| `docs/architecture/observability-profiles/local-observe.yml` | `afk observe` 的本地 profile 示例 |

## 双语版本

英文为主语言的文件提供 `_zh` 平铺版本（例：`overview.md` / `overview.zh.md`）。
