# Workflow Buttons and Status Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign workflow library and canvas controls as compact desktop-tool controls, and replace prominent or unlabeled status treatments with quiet inline state indicators.

**Architecture:** Keep all behavior in the existing `Workflows`, `WorkflowLibrary`, `WorkflowStudio`, and `WorkflowStudioInspector` components. Add only a pure node-state label helper and semantic class names needed for styling; implement the visual system in the existing workflow section of `control.css` without changing IPC contracts or canvas behavior.

**Tech Stack:** React 19, TypeScript, CSS, Lucide React, Playwright E2E.

---

### Task 1: Lock the compact control and status contract with E2E tests

**Files:**
- Modify: `desktop-client/tests/e2e/workflow.spec.ts`

- [ ] **Step 1: Add failing assertions for the library status and create control**

Add a test that opens the workflow page and verifies the current card exposes a semantic status element while the create button remains icon-only and compact:

```ts
test("uses compact workflow library controls and a quiet current-template status", async ({ page }) => {
  await page.getByRole("button", { name: "工作流" }).click();

  const createButton = page.getByRole("button", { name: "新建工作流" });
  const createBox = await createButton.boundingBox();
  if (!createBox) throw new Error("workflow create control is not measurable");
  expect(createBox.width).toBeLessThanOrEqual(30);
  expect(createBox.height).toBeLessThanOrEqual(30);

  const activeCard = page.locator(".workflow-library-card.active");
  await expect(activeCard.locator(".workflow-library-card-status")).toHaveText("当前模板");
  await expect(activeCard.locator(".workflow-library-card-status")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});
```

- [ ] **Step 2: Add failing assertions for compact studio buttons and readable node state**

Add a test that opens the first workflow and verifies the save/add controls and node state:

```ts
test("uses compact studio controls and inline node state labels", async ({ page }) => {
  await page.getByRole("button", { name: "工作流" }).click();
  await page.locator(".workflow-library-card").first().click();

  const saveButton = page.getByRole("button", { name: "保存", exact: true }).first();
  const addButton = page.getByRole("button", { name: "添加工作流步骤" });
  const saveBox = await saveButton.boundingBox();
  const addBox = await addButton.boundingBox();
  if (!saveBox || !addBox) throw new Error("workflow controls are not measurable");
  expect(saveBox.height).toBeLessThanOrEqual(28);
  expect(addBox.width).toBeLessThanOrEqual(28);
  expect(addBox.height).toBeLessThanOrEqual(28);

  const nodeStatus = page.locator(".workflow-editor-node .workflow-node-status").first();
  await expect(nodeStatus).toHaveText(/就绪|运行中|已完成|待执行/);
  await expect(nodeStatus).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});
```

- [ ] **Step 3: Run the two new tests and verify they fail**

Run:

```bash
cd desktop-client
pnpm exec playwright test tests/e2e/workflow.spec.ts --grep "compact workflow library|compact studio controls"
```

Expected: both tests fail because `.workflow-library-card-status` and `.workflow-node-status` do not exist and current controls exceed the compact dimensions.

### Task 2: Add semantic status markup without changing behavior

**Files:**
- Modify: `desktop-client/src/main.tsx:374`
- Modify: `desktop-client/src/main.tsx:436`
- Modify: `desktop-client/src/main.tsx:556`

- [ ] **Step 1: Add the pure node-state label helper**

Add next to `workflowStatusLabel`:

```ts
function workflowNodeStateLabel(state: WorkflowCanvasNode["state"]) {
  const labels: Record<WorkflowCanvasNode["state"], string> = {
    active: "运行中",
    ready: "就绪",
    muted: "待执行",
    complete: "已完成",
  };
  return labels[state];
}
```

- [ ] **Step 2: Give the active library marker a dedicated semantic class**

Replace the active card marker with:

```tsx
{active ? <em className="workflow-library-card-status"><span aria-hidden="true" />当前模板</em> : <ChevronRight size={15} aria-hidden="true" />}
```

- [ ] **Step 3: Replace the dirty pill class with a quiet inline status class**

Change the dirty indicator to:

```tsx
{dirty ? <span className="workflow-dirty"><span aria-hidden="true" />未保存</span> : null}
```

- [ ] **Step 4: Add visible node state text while preserving the existing node-kind accessibility label**

Replace the trailing node marker with:

```tsx
<span className={`workflow-node-status ${node.state}`}>
  <span aria-hidden="true" />
  {workflowNodeStateLabel(node.state)}
</span>
```

Retain the node-kind description through the button's existing content and class names; do not alter click, pointer, or drag handlers.

- [ ] **Step 5: Run TypeScript typecheck**

Run:

```bash
cd desktop-client
pnpm typecheck
```

Expected: exit code 0.

### Task 3: Implement the compact AFK control language

**Files:**
- Modify: `desktop-client/src/control.css:410`
- Modify: `desktop-client/src/control.css:650`
- Modify: `desktop-client/src/control.css:880`
- Modify: `desktop-client/src/control.css:1120`

- [ ] **Step 1: Restyle library controls and active status**

Implement these constraints in the final workflow override section:

```css
.workflow-create {
  width: 28px;
  min-height: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--afk-border);
  border-radius: 5px;
  background: var(--afk-panel);
  color: var(--afk-muted);
  box-shadow: none;
}
.workflow-create::before {
  position: absolute;
  top: -1px;
  left: 6px;
  right: 6px;
  height: 1px;
  background: var(--afk-accent-border);
  content: "";
}
.workflow-library-card header em.workflow-library-card-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0;
  background: transparent;
  color: var(--afk-accent);
}
.workflow-library-card-status > span {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
}
```

Ensure `.workflow-create` is positioned so its keyline pseudo-element is contained, and keep hover/focus states subtle.

- [ ] **Step 2: Restyle top-bar and inspector actions**

Apply one filled dark-neutral primary action per context:

```css
.workflow-studio-actions .workflow-save,
.workflow-studio-inspector .workflow-save {
  min-height: 27px;
  height: 27px;
  padding: 0 10px;
  border-color: #343936;
  border-radius: 5px;
  background: #343936;
  box-shadow: none;
  color: #fff;
  font-size: 9px;
}
.workflow-dirty {
  display: inline-flex;
  min-height: 18px;
  align-items: center;
  gap: 5px;
  padding: 0;
  border: 0;
  background: transparent;
  color: #a96d25;
}
.workflow-dirty > span {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
}
```

Keep reset and destructive buttons neutral and compact, with color introduced only on hover/focus.

- [ ] **Step 3: Restyle toolbar and canvas icon controls**

Use 26–28px controls with low-radius borders and no default shadow:

```css
.workflow-studio-toolbar .workflow-toolbar-button {
  width: 26px;
  min-height: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--afk-border);
  border-radius: 5px;
  background: var(--afk-panel);
  box-shadow: none;
}
.workflow-canvas-controls .workflow-canvas-control {
  width: 27px;
  height: 27px;
  border-radius: 4px;
}
```

Retain the existing control group, zoom label, aria labels, and click handlers.

- [ ] **Step 4: Render node status as an unboxed inline indicator**

Update the node grid and add the status rules:

```css
.workflow-editor-node {
  grid-template-columns: 22px minmax(0, 1fr) auto;
}
.workflow-node-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  align-self: start;
  margin-top: 5px;
  background: transparent;
  color: #858b84;
  font-family: "DM Mono", monospace;
  font-size: 7px;
  font-weight: 650;
  white-space: nowrap;
}
.workflow-node-status > span {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
}
.workflow-node-status.active { color: #5268a2; }
.workflow-node-status.complete { color: #4f8b7d; }
.workflow-node-status.muted { color: #9a7a52; }
```

Remove or override the obsolete trailing `em` marker rules.

- [ ] **Step 5: Add graphite-theme equivalents**

Use a light neutral primary button and quiet status colors in graphite mode:

```css
:root[data-afk-theme="graphite"] .workflow-studio-actions .workflow-save,
:root[data-afk-theme="graphite"] .workflow-studio-inspector .workflow-save {
  border-color: #d7dad4;
  background: #d7dad4;
  color: #222521;
}
:root[data-afk-theme="graphite"] .workflow-node-status.active { color: #a9b9df; }
:root[data-afk-theme="graphite"] .workflow-node-status.complete { color: #9bc8bd; }
```

Preserve the existing graphite select-menu changes in the same file.

- [ ] **Step 6: Run focused E2E tests**

Run:

```bash
cd desktop-client
pnpm exec playwright test tests/e2e/workflow.spec.ts
```

Expected: all workflow E2E tests pass.

### Task 4: Verify the desktop package

**Files:**
- Verify only.

- [ ] **Step 1: Run unit tests**

```bash
cd desktop-client
pnpm test
```

Expected: exit code 0.

- [ ] **Step 2: Run typecheck**

```bash
cd desktop-client
pnpm typecheck
```

Expected: exit code 0.

- [ ] **Step 3: Run the production build**

```bash
cd desktop-client
pnpm build
```

Expected: exit code 0.

- [ ] **Step 4: Review the final diff**

Confirm the diff changes only workflow markup, workflow styles, focused tests, and the approved design/prototype artifacts. Confirm the pre-existing select-menu changes remain intact.
