# SSH Diagnostics UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 SSH 配置诊断从重复长文本改为按问题类型分组、可展开且能定位受影响 Host 的提示组件。

**Architecture:** 保持主进程负责解析诊断，给可关联 Host 的诊断补充 `hostAlias`。渲染层新增纯函数聚合结构化诊断，并由 SSH 页面渲染摘要、分组详情和配置路径；连接与安全流程不变。

**Tech Stack:** React、TypeScript、Electron IPC DTO、Vitest、CSS。

---

### Task 1: 扩展 SSH 诊断 DTO 并补解析测试

**Files:**
- Modify: `desktop-client/shared/ssh-contract.ts:20-38`
- Modify: `desktop-client/electron/adapters/ssh-config-adapter.ts:31-55`
- Test: `desktop-client/tests/electron/ssh-config-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

在现有 SSH 配置适配器测试中加入断言：未知指令和无法解析的配置行都包含对应 Host 别名；非具体 Host 的诊断不包含 Host 别名。

```ts
expect(result.diagnostics).toEqual(expect.arrayContaining([
  expect.objectContaining({ code: "ssh.unknown-directive", hostAlias: "demo" }),
  expect.objectContaining({ code: "ssh.malformed-directive", hostAlias: "demo" }),
]));
expect(result.diagnostics.find((item) => item.code === "ssh.non-concrete-host")).not.toHaveProperty("hostAlias");
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm vitest run --config vitest.config.ts tests/electron/ssh-config-adapter.test.ts`

Expected: FAIL because `SshDiagnostic` and parser output do not provide `hostAlias`.

- [ ] **Step 3: Implement the DTO and parser change**

Add `hostAlias?: string` to `SshDiagnostic`. When `parseBlocks` creates `ssh.unknown-directive` or `ssh.malformed-directive`, set `hostAlias: current.alias`. Leave `ssh.non-concrete-host` without the field.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm vitest run --config vitest.config.ts tests/electron/ssh-config-adapter.test.ts`

Expected: PASS.

### Task 2: Add pure diagnostic aggregation

**Files:**
- Create: `desktop-client/src/features/ssh/ssh-diagnostics.ts`
- Create: `desktop-client/tests/ssh-diagnostics.test.ts`

- [ ] **Step 1: Write the failing tests**

Cover duplicate warnings, different paths, different severities, and diagnostics without Host aliases.

```ts
const grouped = groupSshDiagnostics([
  { code: "ssh.unknown-directive", severity: "warning", message: "Host demo 包含未识别配置项", path: "~/.ssh/config", hostAlias: "demo" },
  { code: "ssh.unknown-directive", severity: "warning", message: "Host prod 包含未识别配置项", path: "~/.ssh/config", hostAlias: "prod" },
]);
expect(grouped).toEqual([expect.objectContaining({ count: 2, hostAliases: ["demo", "prod"], path: "~/.ssh/config" })]);
```

The grouping key must normalize the Host-specific prefix in messages so `demo` and `prod` form one group. Diagnostics with different paths or severities must remain separate. A diagnostic without `hostAlias` must retain its original message and group safely.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm vitest run --config vitest.config.ts tests/ssh-diagnostics.test.ts`

Expected: FAIL because the aggregation module does not exist.

- [ ] **Step 3: Implement the pure aggregation function**

Export `groupSshDiagnostics(diagnostics: SshDiagnostic[]): GroupedSshDiagnostic[]`. Each result includes `code`, `severity`, normalized `message`, optional `path`, `count`, and unique sorted `hostAliases`. Keep ordering by first appearance so the UI preserves parser order.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm vitest run --config vitest.config.ts tests/ssh-diagnostics.test.ts`

Expected: PASS.

### Task 3: Replace the SSH diagnostic banner with grouped details

**Files:**
- Modify: `desktop-client/src/features/ssh/SshHostsPage.tsx:1-75`
- Modify: `desktop-client/src/features/ssh/ssh.css:1-15, 60-65`

- [ ] **Step 1: Wire structured diagnostics into the page**

Keep `SshDiagnostic[]` in component state instead of mapping immediately to strings. Derive `groupedDiagnostics` with `useMemo(() => groupSshDiagnostics(diagnostics), [diagnostics])`.

- [ ] **Step 2: Render a compact summary and expandable groups**

Render a `section` with an accessible heading such as `SSH 配置提示 · ${diagnostics.length} 项`. Each group shows a friendly label based on its code, count, severity, and optional path. Render Host aliases as compact tags inside `<details><summary>查看受影响 Host</summary>…</summary></details>`; omit that control when the group has no aliases.

- [ ] **Step 3: Add the visual treatment**

Use a low-saturation warning panel with a separate header row, count badge, group rows, monospace path, and wrapping Host tags. Keep graphite theme overrides readable and preserve existing error/success alert colors.

- [ ] **Step 4: Run the desktop checks**

Run: `pnpm test`

Expected: all existing tests plus the new SSH diagnostic tests pass.

Run: `pnpm typecheck`

Expected: TypeScript checks pass for renderer, Electron, and shared contracts.

Run: `pnpm build`

Expected: production renderer and Electron main build complete successfully.

### Task 4: Verify the running Electron service

**Files:**
- No source changes.

- [ ] **Step 1: Start the service**

Run from `desktop-client`: `pnpm dev:raw`

Expected: Vite listens on `http://localhost:5174/`, Electron opens `AFK Control`, and the main-process watcher reports zero TypeScript errors.

- [ ] **Step 2: Verify the SSH page**

Open the Electron window, select `SSH 主机`, and confirm the diagnostics area shows one compact grouped summary instead of repeated text. Expand a group and confirm affected Host aliases and `~/.ssh/config` are visible.

- [ ] **Step 3: Check the final diff**

Run: `git diff --check`

Expected: no whitespace errors.

