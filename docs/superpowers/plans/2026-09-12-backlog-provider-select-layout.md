# Backlog Provider Select Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Provider 选择器改为文字与箭头整体居中的紧凑通用组件变体。

**Architecture:** 在 `SelectMenu` props 中增加可选布局参数并输出修饰 class，默认布局保持不变。Backlog 页仅为顶部 Provider 实例启用居中变体，宽度和视觉规则继续由页面局部 CSS 控制。

**Tech Stack:** React、TypeScript、CSS、Vitest、react-test-renderer、Playwright

---

### Task 1: 添加选择器布局变体测试

**Files:**
- Modify: `desktop-client/tests/select-menu.test.tsx`
- Modify: `desktop-client/tests/e2e/backlog-list.spec.ts`

- [x] 增加组件测试，断言 `triggerLayout="center"` 输出 `select-menu centered-trigger`，默认实例仍输出 `select-menu`。
- [x] 更新 E2E 几何断言，验证文字与箭头间距紧凑且二者组成的整体接近按钮中心。
- [x] 运行测试并确认旧实现失败。

### Task 2: 实现居中触发器变体

**Files:**
- Modify: `desktop-client/src/components/SelectMenu.tsx`
- Modify: `desktop-client/src/features/backlog/BacklogPage.tsx`
- Modify: `desktop-client/src/features/backlog/backlog.css`

- [x] 为 `SelectMenu` 添加可选 `triggerLayout?: "default" | "center"` 属性，默认值为 `default`。
- [x] 为居中实例输出 `centered-trigger` 修饰 class。
- [x] Provider 实例启用 `triggerLayout="center"`。
- [x] 删除三列网格和伪占位规则，使用 `inline-flex`、`justify-content: center` 和合理间距组织文字与箭头。
- [x] 将 Provider 选择器宽度收紧为 112px。
- [x] 运行针对性测试、类型检查、完整单测和 Backlog E2E。
