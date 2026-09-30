# Backlog Status Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Provider Backlog 工作项的状态与执行模式改为原型 A 的双标签展示，并让顶部 Provider 选择器当前文案真正居中。

**Architecture:** 保持现有 `BacklogPage` 数据与交互不变，只调整 JSX 信息结构并在 `backlog.css` 中增加页面局部样式。状态语义色通过 `BacklogState` 值生成稳定 class，Provider 居中规则限定在 `.backlog-heading-actions`，避免影响状态筛选和弹窗选择器。

**Tech Stack:** React 19、TypeScript、CSS、Vitest、react-test-renderer、Playwright

---

### Task 1: 添加状态标签与 Provider 对齐回归测试

**Files:**
- Modify: `desktop-client/tests/backlog-page.test.tsx`
- Modify: `desktop-client/tests/e2e/backlog-list.spec.ts`

- [x] **Step 1: 为工作项双标签写失败的组件测试**

在 `BacklogPage initial render` 中断言每条工作项包含 `.backlog-item-metadata`、`.backlog-state-label` 与 `.backlog-mode-label`，并确认状态 class 包含真实状态值：

```tsx
const metadata = rows[0].findByProps({ className: "backlog-item-metadata" });
expect(metadata.findByProps({ className: "backlog-state-label backlog-state-ready" })).toBeTruthy();
expect(textContent(metadata.findByProps({ className: "backlog-state-label backlog-state-ready" }))).toBe("待处理");
expect(textContent(metadata.findByProps({ className: "backlog-mode-label" }))).toBe("AFK 自动");
```

- [x] **Step 2: 运行组件测试并确认失败**

Run: `cd desktop-client && pnpm vitest run --config vitest.config.ts tests/backlog-page.test.tsx`

Expected: FAIL，因为现有页面仍渲染单个 `<p>` 文本，不存在双标签 class。

- [x] **Step 3: 为 Provider 几何居中写 E2E 断言**

在已有紧凑控件测试中读取 Provider 触发器、文案 `<span>` 与图标的 bounding box，断言文案中心和按钮中心误差不超过 1px，并断言菜单选项仍为 `text-align: left`：

```ts
const alignment = await platform.evaluate((button) => {
  const buttonBox = button.getBoundingClientRect();
  const labelBox = button.querySelector("span")!.getBoundingClientRect();
  return {
    delta: Math.abs((buttonBox.left + buttonBox.width / 2) - (labelBox.left + labelBox.width / 2)),
  };
});
expect(alignment.delta).toBeLessThanOrEqual(1);
```

### Task 2: 实现原型 A 双标签与局部居中样式

**Files:**
- Modify: `desktop-client/src/features/backlog/BacklogPage.tsx`
- Modify: `desktop-client/src/features/backlog/backlog.css`

- [x] **Step 1: 替换工作项状态纯文本结构**

将现有状态 `<p>` 改为无交互的双标签容器：

```tsx
<div className="backlog-item-metadata">
  <span className={`backlog-state-label backlog-state-${item.state}`}>
    <i aria-hidden="true" />
    {backlogStateLabel(item.state)}
  </span>
  <span className="backlog-mode-label">{item.executionMode === "afk" ? "AFK 自动" : "HITL 人工"}</span>
</div>
```

- [x] **Step 2: 添加双标签语义样式**

在 `backlog.css` 中添加紧凑胶囊基础样式，并将状态映射到现有色板：

```css
.backlog-item-metadata { display: flex; align-items: center; gap: 6px; }
.backlog-state-label,
.backlog-mode-label { min-height: 22px; display: inline-flex; align-items: center; border-radius: 999px; font-size: 12px; }
.backlog-state-label { gap: 6px; padding: 0 9px; font-weight: 600; }
.backlog-state-label i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: .78; }
.backlog-mode-label { padding: 0 9px; border: 1px solid var(--backlog-border); color: var(--backlog-muted); }
```

状态 class 使用 `--ready`、`--run`、`--verify`、`--attention` 及其柔和背景变量，不新增全局颜色系统。

- [x] **Step 3: 让顶部 Provider 文案真正居中**

仅对 `.backlog-heading-actions .select-menu-trigger` 使用三列网格，以左侧同宽占位抵消右侧箭头：

```css
.backlog-heading-actions .select-menu-trigger {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr) 14px;
}
.backlog-heading-actions .select-menu-trigger::before { content: ""; }
.backlog-heading-actions .select-menu-trigger > span { text-align: center; }
```

- [x] **Step 4: 运行针对性测试**

Run: `cd desktop-client && pnpm vitest run --config vitest.config.ts tests/backlog-page.test.tsx tests/select-menu.test.tsx`

Expected: PASS，组件结构与通用 SelectMenu 行为均保持正确。

- [x] **Step 5: 运行类型检查、完整单测与 Backlog E2E**

Run: `cd desktop-client && pnpm typecheck && pnpm test && pnpm playwright test --config=playwright.config.ts tests/e2e/backlog-list.spec.ts`

Expected: 全部命令退出码为 0；若 E2E 环境依赖已运行应用，则使用项目现有 Playwright webServer 配置启动。
