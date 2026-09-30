# SSH Action Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the approved hierarchy-first visual treatment to SSH host detail actions without changing behavior.

**Architecture:** Keep `SshActionButton` as the single visual primitive. Add a semantic action-group wrapper in `SshHostsPage` for connection and auxiliary actions, then refine `ssh.css` for primary, secondary, danger, focus, disabled, and responsive states. Preserve all existing callbacks and status guards.

**Tech Stack:** React, TypeScript, CSS, Vitest, React test renderer, pnpm.

---

### Task 1: Lock the detail action hierarchy with a failing test

**Files:**
- Modify: `desktop-client/tests/ssh-page.test.ts`
- Test: `desktop-client/tests/ssh-page.test.ts`

- [x] **Step 1: Add a focused assertion for the approved hierarchy**

Add a test that renders a ready managed host and asserts:

```ts
it("gives the SSH detail actions a clear primary hierarchy", async () => {
  const { renderer } = await renderSshPage();
  const buttonByText = (label: string) => renderer.root.findAllByType("button").find((button) => textContent(button) === label)!;

  expect(buttonByText("连接").props.className).toContain("ssh-action-button-primary");
  expect(buttonByText("测试免密").props.className).toContain("ssh-action-button-secondary");
  expect(buttonByText("删除").props.className).toContain("ssh-action-button-danger");
  expect(renderer.root.findByProps({ className: "ssh-detail-action-groups" })).toBeDefined();
  act(() => { renderer.unmount(); });
  vi.unstubAllGlobals();
});
```

- [x] **Step 2: Run the focused test and confirm it fails**

Run `pnpm --dir desktop-client test --run tests/ssh-page.test.ts -t "clear primary hierarchy"`.

Expected: FAIL because the semantic action-group wrapper does not exist yet.

### Task 2: Implement the semantic action groups

**Files:**
- Modify: `desktop-client/src/features/ssh/SshHostsPage.tsx:337`

- [x] **Step 1: Wrap auxiliary and connection actions without changing handlers**

Change only the details action markup so it uses:

```tsx
<div className="ssh-actions">
  {trustAction}
  {deployAction}
  <div className="ssh-detail-action-groups">
    <div className="ssh-auxiliary-actions">{testAction}</div>
    <div className="ssh-connection-actions">{terminalPicker}{connectAction}</div>
  </div>
  {removeAction}
</div>
```

Keep the existing status conditions, `disabled` expressions, click handlers, labels, and icons exactly as they are. Keep `SshTerminalPicker` inside `.ssh-connection-actions` so its keyboard and popup behavior remains unchanged.

- [x] **Step 2: Run the focused test and confirm it passes**

Run `pnpm --dir desktop-client test --run tests/ssh-page.test.ts -t "clear primary hierarchy"`.

Expected: PASS.

### Task 3: Refine the visual hierarchy and responsive states

**Files:**
- Modify: `desktop-client/src/features/ssh/ssh.css:1-15,79-86,122-129`

- [x] **Step 1: Make the primary action visually dominant**

Use the existing color variables and tokens to replace the warm gradient primary treatment with a solid accent treatment, add a visible `:focus-visible` ring to every action variant, and make the primary connection action flex wider than the terminal selector.

- [x] **Step 2: Style the action groups and de-emphasize destructive actions**

Add `.ssh-detail-action-groups`, `.ssh-auxiliary-actions`, and `.ssh-connection-actions` rules so auxiliary actions share a compact row, connection controls share a second row, and managed-host deletion uses a low-emphasis danger style with enough contrast.

- [x] **Step 3: Preserve narrow layouts**

Update the existing mobile media queries so each group becomes full width, the terminal selector remains usable, and no action overflows below `560px`.

- [x] **Step 4: Re-run the focused test**

Run `pnpm --dir desktop-client test --run tests/ssh-page.test.ts -t "clear primary hierarchy"`.

Expected: PASS.

### Task 4: Verify the affected desktop package

**Files:**
- Verify: `desktop-client/src/features/ssh/SshHostsPage.tsx`
- Verify: `desktop-client/src/features/ssh/ssh.css`
- Verify: `desktop-client/tests/ssh-page.test.ts`

- [ ] **Step 1: Run the SSH page test suite**

Run `pnpm --dir desktop-client test --run tests/ssh-page.test.ts`.

Observed: 28 tests pass and 2 existing jump-host form tests fail because the current branch does not expose `选择跳板机类型`; this is outside the button styling change and remains untouched.

- [x] **Step 2: Run typecheck and build**

Run `pnpm --dir desktop-client typecheck` and `pnpm --dir desktop-client build`.

Expected: both commands exit successfully without changing generated build output in the source patch.

- [x] **Step 3: Inspect the final diff**

Run `git diff --check -- desktop-client/src/features/ssh/SshHostsPage.tsx desktop-client/src/features/ssh/ssh.css desktop-client/tests/ssh-page.test.ts` and `git diff --stat -- desktop-client/src/features/ssh/SshHostsPage.tsx desktop-client/src/features/ssh/ssh.css desktop-client/tests/ssh-page.test.ts`.

Expected: no whitespace errors and only the scoped files are changed by this work.
