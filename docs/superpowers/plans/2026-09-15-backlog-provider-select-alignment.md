# Backlog Provider Select Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Provider Backlog “自动探测” selector use the same left-label/right-chevron trigger layout as the “全部状态” selector.

**Architecture:** Keep the shared `SelectMenu` component and its optional centered variant unchanged. Cover the page-level layout choice with a focused React rendering test, then remove the centered variant only from the Provider selector instance.

**Tech Stack:** React 19, TypeScript, Vitest, react-test-renderer, CSS

---

### Task 1: Align the Provider selector with the status selector

**Files:**
- Modify: `desktop-client/tests/backlog-page.test.tsx`
- Modify: `desktop-client/src/features/backlog/BacklogPage.tsx`

- [ ] **Step 1: Write the failing page-level regression test**

Add this test inside `describe("BacklogPage initial render", ...)` in `desktop-client/tests/backlog-page.test.tsx`:

```tsx
it("uses the same default trigger layout for Provider and status selectors", async () => {
  const { renderer } = await renderBacklogPage();
  const providerSelect = renderer.root.findByProps({ "aria-label": "选择 Provider" }).parent;
  const statusSelect = renderer.root.findByProps({ "aria-label": "筛选状态" }).parent;

  expect(providerSelect?.props.className).toBe("select-menu");
  expect(statusSelect?.props.className).toBe("select-menu");
  act(() => { renderer.unmount(); });
});
```

- [ ] **Step 2: Run the focused test and verify the current layout fails**

Run:

```bash
cd desktop-client && pnpm test -- tests/backlog-page.test.tsx
```

Expected: FAIL because the Provider selector parent has class `select-menu centered-trigger`.

- [ ] **Step 3: Remove the Provider-only centered layout configuration**

In `desktop-client/src/features/backlog/BacklogPage.tsx`, replace the Provider selector invocation with:

```tsx
<SelectMenu label="选择 Provider" value={platform} options={platformOptions} onChange={(value) => { invalidateBacklogCache(); setPlatform(value); }} disabled={busy} />
```

Do not modify `SelectMenu.tsx` or `backlog.css`; the existing default layout already provides the required left-label/right-chevron styling.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
cd desktop-client && pnpm test -- tests/backlog-page.test.tsx
```

Expected: PASS for the full `backlog-page.test.tsx` suite.

- [ ] **Step 5: Run desktop package verification**

Run:

```bash
cd desktop-client && pnpm test && pnpm typecheck && pnpm build
```

Expected: all Vitest tests pass, TypeScript reports no errors, and Vite/Electron builds complete successfully.

- [ ] **Step 6: Review the visual result at desktop and narrow viewport widths**

Start the existing desktop development environment and verify:

```bash
cd desktop-client && pnpm dev
```

Expected: “自动探测” and “全部状态” both show left-aligned text and a right-aligned chevron; the Provider selector stays to the left of the add icon, and the responsive header still fits without overlap.

- [ ] **Step 7: Commit the implementation**

```bash
git add desktop-client/tests/backlog-page.test.tsx desktop-client/src/features/backlog/BacklogPage.tsx
git commit -m "fix(desktop): align backlog provider selector"
```
