# Backlog Detail Deduplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove repeated and low-value information from the desktop Backlog detail drawer while preserving meaningful runtime, metadata, accessibility, and external-link behavior.

**Architecture:** Keep `BacklogPage` responsible for loading `BacklogRuntimeSummary` and keep all presentation decisions inside `BacklogDetailDrawer`. Build the visible metadata rows from existing DTO values, render runtime content only when runtime or active-run data exists, and make focused CSS changes that do not affect Backlog list rows.

**Tech Stack:** React 19, TypeScript, Vitest with `react-test-renderer`, Playwright Electron E2E, CSS, Lucide React.

---

## File Map

- Modify `desktop-client/src/features/backlog/BacklogDetailDrawer.tsx` to consolidate header status and conditionally render runtime and metadata.
- Modify `desktop-client/src/features/backlog/backlog.css` to style the compact header summary and remove drawer-only duplicate selectors.
- Modify `desktop-client/tests/backlog-page.test.tsx` to cover deduplication and conditional metadata.
- Modify `desktop-client/tests/e2e/backlog-list.spec.ts` to verify the visible drawer contains one execution-mode indicator.

### Task 1: Lock the Deduplication Rules with Component Tests

**Files:**
- Modify: `desktop-client/tests/backlog-page.test.tsx:203`

- [ ] **Step 1: Add a failing test for the compact header and empty-section removal**

Add a detail-drawer test that opens the first item with no runtime, parent,
base backlog, or dependencies and asserts:

```tsx
const dialog = renderer.root.findByProps({ role: "dialog" });

expect(textContent(dialog).match(/AFK 自动/g)).toHaveLength(1);
expect(dialog.findAllByProps({ className: "backlog-detail-status-prefix" })).toHaveLength(0);
expect(dialog.findAllByProps({ "aria-label": "执行状态" })).toHaveLength(0);
expect(textContent(dialog)).not.toContain("暂无规范化运行记录");
expect(textContent(dialog)).not.toContain("父工作项");
expect(textContent(dialog)).not.toContain("执行基线");
expect(textContent(dialog)).not.toContain("依赖");
```

- [ ] **Step 2: Add a failing test for populated optional metadata**

Mock a complete summary and assert the optional rows still appear:

```tsx
const detail = {
  ...items[0],
  parentId: "parent-1",
  baseBacklogId: "base-1",
  dependsOn: ["dep-1"],
  tags: ["billing"],
};
api.summary.mockResolvedValue({ backlogId: detail.id, backlog: detail });

expect(textContent(dialog)).toContain("父工作项#parent-1");
expect(textContent(dialog)).toContain("执行基线#base-1");
expect(textContent(dialog)).toContain("标签billing");
expect(textContent(dialog)).toContain("依赖#dep-1");
```

- [ ] **Step 3: Add a failing test for meaningful runtime content**

Mock a summary containing a runtime projection and assert the runtime panel
and diagnostic grid are present:

```tsx
api.summary.mockResolvedValue({
  backlogId: "1",
  backlog: items[0],
  runtime: {
    runId: "run-1",
    status: "running",
    phase: "implementing",
    heartbeatAt: "2026-09-16T12:00:00.000Z",
    progress: "正在执行测试",
  },
});

expect(dialog.findAllByProps({ "aria-label": "执行状态" })).toHaveLength(1);
expect(textContent(dialog)).toContain("实现执行中");
expect(textContent(dialog)).toContain("正在执行测试");
```

- [ ] **Step 4: Run the focused tests and verify they fail for the intended reasons**

Run:

```bash
cd desktop-client
pnpm exec vitest run --config vitest.config.ts tests/backlog-page.test.tsx
```

Expected: the new assertions fail because the drawer still contains the
standalone prefix, duplicate execution-mode representation, empty runtime
placeholder, and default metadata rows.

### Task 2: Implement Conditional Drawer Presentation

**Files:**
- Modify: `desktop-client/src/features/backlog/BacklogDetailDrawer.tsx:1`

- [ ] **Step 1: Derive runtime and metadata visibility from the summary**

Inside `BacklogDetailDrawer`, derive the conditions before returning JSX:

```tsx
const hasRuntime = Boolean(summary?.runtime || summary?.activeRun);
const metadata = [
  item.providerRef ? { icon: <Hash size={13} />, label: "Provider 引用", value: item.providerRef } : null,
  item.branchName ? { icon: <GitBranch size={13} />, label: "分支", value: item.branchName } : null,
  item.parentId ? { icon: <Hash size={13} />, label: "父工作项", value: `#${item.parentId}` } : null,
  item.baseBacklogId ? { icon: <GitBranch size={13} />, label: "执行基线", value: `#${item.baseBacklogId}` } : null,
  item.tags.length ? { icon: <Tags size={13} />, label: "标签", value: item.tags.join("、") } : null,
  item.dependsOn.length ? { icon: <Hash size={13} />, label: "依赖", value: item.dependsOn.map((id) => `#${id}`).join("、") } : null,
].filter((entry): entry is NonNullable<typeof entry> => entry !== null);
```

- [ ] **Step 2: Consolidate ID, state, and execution mode under the title**

Move the status content into the drawer header and render one execution-mode
tag containing both icon and text:

```tsx
<div className="backlog-detail-summary">
  <small>#{item.id}</small>
  <span aria-hidden="true">·</span>
  <span className={`backlog-status-pill ${item.state}`}>{backlogStateLabel(item.state)}</span>
  <span className={`backlog-mode-tag is-${item.executionMode}`}>
    {item.executionMode === "afk" ? <Bot size={14} aria-hidden="true" /> : <Hand size={14} aria-hidden="true" />}
    {item.executionMode === "afk" ? "AFK 自动" : "HITL 人工"}
  </span>
</div>
```

Remove the standalone `backlog-detail-status-prefix` and drawer-level
`backlog-mode-mark` elements.

- [ ] **Step 3: Render runtime content only when meaningful data exists**

Wrap the existing runtime summary and runtime/active-run diagnostic grids in
one conditional region:

```tsx
{hasRuntime ? (
  <section className="backlog-runtime-panel" aria-label="执行状态">
    <span className="backlog-detail-section-title">运行</span>
    {/* existing runtime or active-run status content */}
  </section>
) : null}
```

Delete the `暂无规范化运行记录。` fallback. Preserve the existing runtime
status labels and diagnostic values when those objects exist.

- [ ] **Step 4: Render only visible metadata rows**

Replace the fixed metadata grid with:

```tsx
{metadata.length ? (
  <section className="backlog-detail-grid" aria-label="工作项元数据">
    {metadata.map((entry) => (
      <DetailValue key={entry.label} icon={entry.icon} label={entry.label} value={entry.value} />
    ))}
  </section>
) : null}
```

Do not render `—`, `默认目标分支`, `无标签`, or `无依赖` fallbacks.

- [ ] **Step 5: Run the focused tests and verify they pass**

Run:

```bash
cd desktop-client
pnpm exec vitest run --config vitest.config.ts tests/backlog-page.test.tsx
```

Expected: all Backlog page tests pass.

### Task 3: Refine Drawer Styling Without Affecting List Rows

**Files:**
- Modify: `desktop-client/src/features/backlog/backlog.css:422`

- [ ] **Step 1: Add compact header-summary styling**

Add drawer-scoped styles:

```css
.backlog-detail-summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 8px;
}
.backlog-detail-summary > small {
  color: var(--backlog-muted);
  font-family: var(--font-mono, monospace);
}
.backlog-detail-summary > [aria-hidden="true"] {
  color: var(--backlog-border-strong);
}
.backlog-detail-summary .backlog-mode-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
```

- [ ] **Step 2: Remove obsolete drawer-only selectors**

Delete `.backlog-detail-status-prefix` and any status-row spacing rules that
only supported the old standalone prefix/mark/tag layout. Keep shared
`.backlog-mode-mark` styles because Backlog list rows still use them.

- [ ] **Step 3: Verify CSS and TypeScript consistency**

Run:

```bash
cd desktop-client
pnpm typecheck
```

Expected: both renderer and Electron TypeScript checks pass.

### Task 4: Update Electron E2E Coverage and Run Final Verification

**Files:**
- Modify: `desktop-client/tests/e2e/backlog-list.spec.ts:129`

- [ ] **Step 1: Replace the duplicate-mode E2E expectation**

Update the drawer mode test to assert one combined tag and no standalone mode
mark:

```ts
await page.locator(".backlog-row").first().click();
const drawer = page.getByRole("dialog", { name: "登录态切换" });

await expect(drawer.locator(".backlog-mode-mark")).toHaveCount(0);
await expect(drawer.locator(".backlog-mode-tag")).toHaveCount(1);
await expect(drawer.locator(".backlog-mode-tag")).toContainText("AFK 自动");
await expect(drawer.getByText("暂无规范化运行记录。", { exact: true })).toHaveCount(0);
```

- [ ] **Step 2: Run the focused unit test, typecheck, and Electron E2E test**

Run:

```bash
cd desktop-client
pnpm exec vitest run --config vitest.config.ts tests/backlog-page.test.tsx
pnpm typecheck
AFK_E2E_PORT=5187 pnpm exec playwright test --config=playwright.config.ts tests/e2e/backlog-list.spec.ts --grep "detail preview|combined mode"
```

Expected: all commands pass. Use another unused port if `5187` is occupied;
do not terminate an existing development server.

- [ ] **Step 3: Check the final patch**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only the approved drawer source, CSS, focused
tests, design document, and implementation plan are modified. Do not create a
Git commit unless the user explicitly requests one.
