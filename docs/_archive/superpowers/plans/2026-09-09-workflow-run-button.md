# Backlog 开始执行按钮 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Provider Backlog 卡片的开始执行入口移动到右上角并改为靛蓝圆形播放按钮，同时保持现有执行逻辑。

**Architecture:** 先将已有 backlog 执行能力同步到当前分支，再在现有 `BacklogPage` 卡片标题行复用 `startRun` 回调。样式集中放在现有 backlog CSS 中，按钮只改变布局与视觉，不新增跨进程接口。

**Tech Stack:** React 19、TypeScript、lucide-react、CSS、Vitest、React Test Renderer。

---

### Task 1: 同步 backlog 执行能力

**Files:**
- Modify: `desktop-client/shared/backlog-contract.ts`
- Modify: `desktop-client/shared/ipc-contract.ts`
- Modify: `desktop-client/electron/preload.ts`
- Modify: `desktop-client/electron/ipc/register-handlers.ts`
- Create: `desktop-client/electron/services/backlog-execution-service.ts`
- Create: `desktop-client/electron/services/backlog-run-store.ts`

- [ ] **Step 1: 写失败测试**

补齐 `backlog.start` 与 `backlog.runs` 类型、preload 白名单、IPC handler、执行服务和运行记录持久化。

- [ ] **Step 2: 运行针对性测试确认失败**

运行 `pnpm --dir desktop-client test -- backlog-execution-service backlog-run-store`，预期执行能力相关测试通过。

### Task 2: 实现右上角圆形播放按钮

**Files:**
- Modify: `desktop-client/src/features/backlog/BacklogPage.tsx`
- Modify: `desktop-client/src/features/backlog/backlog.css`
- Test: `desktop-client/tests/backlog-page.test.tsx`

- [ ] **Step 1: 添加播放图标 import**

从 `lucide-react` 引入 `Play`，并保留 `startRun`、运行状态水合及错误处理。

- [ ] **Step 2: 添加最小 JSX**

在每个 backlog 卡片的 `<header>` 中保留标题和编号，并新增：

```tsx
<button className="backlog-run-button" onClick={(event) => { event.stopPropagation(); void startRun(item); }} aria-label="开始执行" title="开始执行">
  <Play size={14} fill="currentColor" aria-hidden="true" />
</button>
```

按钮复用现有 `startRun(item)` 回调，不增加新的执行状态。

- [ ] **Step 3: 添加 A 方案样式**

使用现有 backlog 靛蓝强调色、白色图标、圆形边界、悬停和键盘焦点状态；保持卡片标题行的收缩与响应式规则。

### Task 3: 验证

**Files:**
- Test: `desktop-client/tests/workflow-page.test.tsx` 或实际存在的工作流测试文件

- [ ] **Step 1: 运行相关测试**

运行 `pnpm --dir desktop-client test -- backlog-page`，预期全部通过。

- [ ] **Step 2: 运行桌面端类型检查与构建**

运行 `pnpm --dir desktop-client typecheck` 和 `pnpm --dir desktop-client build`，预期退出码均为 0。

- [ ] **Step 3: 检查差异**

运行 `git diff --check` 和 `git diff --stat`，确认没有空白错误或无关文件变化。
