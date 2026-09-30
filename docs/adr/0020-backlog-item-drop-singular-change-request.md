# ADR-0020 — Drop `BacklogItem.changeRequest` (singular) in favor of `changeRequests[]`

- **Status:** proposed
- **Date:** 2026-09-29
- **Decision Drivers:** PR list work item (PRD), 返工历史可见性, 单一数据源原则

## Context

`BacklogItem.changeRequest?: BacklogChangeRequest` (`src/domain/backlog/index.ts:48`) 在 PR 数据进入桌面时由 `withChangeRequest()` (`src/domain/backlog/tracker-adapter.ts:131-148`) 写入。该方法按分支名 (`<branchName>-qa` 优先，再 `<branchName>`) 挑出**最近一条** MR，**覆盖**而非追加。返工产生的旧 PR 因此在 CLI 输出里被替换掉。

新需求让桌面 UI 展示**一对多历史 PR 列表**。如果保留单字段 + 增并列数组，需要：
- CLI 双写两份并保持顺序一致
- 读端代码选择其一（增加心智负担）
- 单数字段语义永久模糊（"最新" 还是 "任意一条"？）

## Decision

`BacklogItem.changeRequest?: BacklogChangeRequest`（单数）**删除**。新增 `BacklogChangeRequest[]` `changeRequests?`（数组，**始终为数组**，无 open 状态过滤）。所有 reader 迁到 `changeRequests[0]`（拿"最新一条"）或遍历（拿"历史"）。

CLI 输出顺序：
1. `state === 'open'` 优先
2. 其余按 `createdAt` 倒序
3. 无 `createdAt` 时按 `id` 倒序

`BacklogChangeRequest` 类型新增 `createdAt?: string` 字段（GitHub/GitLab 各自已有的时间戳透传上来）。

## Consequences

**正向**：
- 单一来源 — 不需要 CLI 维护两份状态
- `execute-work-item.ts:432` 的 reconciliation 检查升级为"列表对账"，能检测 force-push 导致的新 PR id
- in-memory 测试 fixtures 改一处即可，无需双套

**代价**：
- `BacklogItem.changeRequest` 移除是破坏性变更，影响 `execute-work-item.ts:432`、`BacklogDetailDrawer.tsx:77-80`、所有 in-memory fixture
- `desktop-client/shared/backlog-contract.ts` 的 `assertExactKeys` 必须同步更新（`BacklogItem` 的合法字段集改变）
- 一次性发版升级需要迁移脚本或文档

**撤销方案**：
- 数据模型可以回滚到单字段；CLI 已经发出的历史 PR id 不可撤销（已发布到 GitHub/GitLab 的 MR 不能删除），但 UI 行为可回滚