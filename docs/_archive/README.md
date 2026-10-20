# 归档区（`_archive/`）

这里保存的是**当时的仓库快照**，不是当前指引。

一份文档被归档，通常意味着下面三种情况之一：

- 它描述的功能已经被实现并取代——看 `docs/architecture/` 里的现行文档；
- 它描述的方案已经被否决——看同一主题的 ADR 或仍在生效的蓝图；
- 它是一次已经完成的实施计划——它的结论已经落进代码。

**不要把归档件当作需求来源或事实来源。** 仓库当前的状态由 `docs/index.md` 列出的文档和代码本身决定。

## 目录

| 目录 | 内容 | 数量 |
|---|---|---|
| `superpowers/plans/` | 过去的实施计划 | 52 份 |
| `superpowers/specs/` | 过去的设计规格 | 36 份 |
| `prototype/` | 历史 UI 原型（HTML / PNG） | 14 个文件，5 个主题 |
| `design-demos/` | 历史 design demo 与截图 | 9 个文件 |
| `blueprints/` | 已被实现或已被否决的蓝图 | 2 份 |
| `decisions/` | 针对已不存在的代码结构的阶段性调研 | 1 份 |

## 按主题

### SSH 与堡垒机

这一组最多，也最容易被误当成待办：它们记录的是一度规划、后来没有落地的 SSH 管理与
JumpServer 对接能力。仓库里现在有 `ssh-service.ts`、`jumpserver-service.ts` 与
`jumpserver-credential-service.ts`，但那是后来的、更小的一套实现，与这组计划不是
同一件事。

计划：`ssh-management` `ssh-cache` `ssh-deploy-password` `ssh-diagnostics-ux`
`ssh-dual-terminal` `ssh-standard-directives` `ssh-terminal-picker` `ssh-xterm`
`ssh-action-buttons` `ssh-host-edit` `ssh-managed-host-target` `ssh-scp-upload`
规格：`ssh-management-design` `ssh-cache-design` `ssh-deploy-password-design`
`ssh-diagnostics-ux-design` `ssh-dual-terminal-design`
`ssh-standard-directives-design` `ssh-terminal-picker-design` `ssh-xterm-design`
`ssh-action-buttons-design` `ssh-host-edit-design` `ssh-managed-host-target-design`

### Backlog 与 Provider

计划：`backlog-cli-hard-cutover` `backlog-provider-refactor` `filesystem-claim-fallback`
`backlog-label-delta` `afk-backlog-create-plan` `backlog-detail-drawer`
`backlog-provider-select-layout` `backlog-status-labels`
`backlog-provider-select-alignment` `backlog-detail-deduplication`
`backlog-pr-association` `work-item-backlog-linkage`
`unified-work-item-execution`
规格：`backlog-provider-design` `backlog-label-delta-design`
`backlog-detail-drawer-design` `backlog-provider-select-layout-design`
`backlog-status-labels-design` `backlog-detail-deduplication-design`

### TUI 与看板

计划：`tui-backlog-provider` `tui-operational-subviews` `tui-kanban-board`
`tui-live-task-cockpit` `tui-external-plugin-implementation`
`remove-sidebar-refresh-status` `ponytail-repository-simplification`
规格：`tui-backlog-provider-design` `tui-operational-subviews-design`
`tui-kanban-board-design` `tui-live-task-cockpit-design`
`tui-external-plugin-design` `desktop-internationalization-design`

### 执行运行时与工作流

计划：`agent-execution-boundary` `qa-rework-and-ac-loop` `task-runtime-monitor`
`codex-provider-e2e` `codex-multi-runtime` `archify-workflow-integration`
`desktop-electron-refactor` `desktop-merge-fixes` `desktop-task-execution-closed-loop`
`global-work-item-sandbox-refactor` `work-items-filter-and-load-more`
`run-center-workspace-ui` `retro-feedback-loop` `workflow-run-button`
`workflow-canvas-interactions` `workflow-buttons-status-implementation`
`workflow-inspector-select-menu-plan`
规格：`agent-execution-boundary-design` `task-runtime-monitor-design`
`codex-provider-e2e-design` `codex-multi-runtime-design`
`archify-workflow-integration-design` `observability-harness-baseline`
`desktop-task-execution-closed-loop-design` `desktop-persistent-list-models-design`
`work-items-filter-and-load-more-design` `run-center-board-design`
`workflow-run-button-design` `backlog-run-button-size-design`
`workflow-canvas-interactions-design` `workflow-buttons-status-design`
`workflow-inspector-select-menu-design`

### 已采纳但已归档的蓝图

| 文件 | 结论 |
|---|---|
| `blueprints/afk-native-graph-engine-blueprint.md` | 已实现为 `packages/afk-workflow-graph/` |
| `blueprints/archify-afk-integration-proposal.md` | 方向被原生图引擎蓝图否决 |

### 面向另一套代码库的调研

`decisions/observability-2026-08-02.md` 是一份针对 `src/lib/**` 布局与
`afk issue` / `afk worktree` 等命令的可观测性普查，那些代码在本仓库从未存在。
其核心结论已被 ADR-0016 推翻。当前可观测性指南是
`docs/architecture/observability.md`。
