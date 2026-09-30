# Run Center Workspace UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将桌面端运行中心改成 Codex 风格的干净工作区：队列使用连续状态流，看板使用图标化列头，GitHub/GitLab 来源结构化展示，详情 Inspector 默认收起。

**Architecture:** 保留现有 `RuntimeEvent`、Snapshot、IPC 和运行生命周期，只在渲染层增加纯函数化的来源解析与状态视觉语义。`main.tsx` 负责组合运行中心视图，CSS 负责状态轨道、图标化列头、紧凑列表和轻量动效；所有新纯函数先用 Vitest 覆盖。

**Tech Stack:** React 19, TypeScript, `lucide-react`, Vitest, 现有 `ProviderIcon` 资源和桌面端 CSS。

---

### Task 1: Add tested runtime presentation helpers

**Files:**
- Create: `desktop-client/src/features/run-center/runtime-presentation.ts`
- Test: `desktop-client/tests/run-center-presentation.test.ts`

- [ ] **Step 1: Write failing tests**

  Cover GitHub, GitLab, plain-source fallback, and state metadata:

  ```ts
  expect(parseRuntimeSource("github:easyhaloo/afk #144")).toEqual({ provider: "github", repository: "easyhaloo/afk", workItem: "#144" });
  expect(parseRuntimeSource("gitlab:platform/runner #139")).toEqual({ provider: "gitlab", repository: "platform/runner", workItem: "#139" });
  expect(parseRuntimeSource("local-backlog #12")).toEqual({ provider: undefined, repository: "local-backlog", workItem: "#12" });
  expect(runtimeStateMeta("active").ariaLabel).toBe("执行中");
  expect(runtimeStateMeta("attention").icon).toBe("attention");
  expect(runtimeStateMeta("failed").ariaLabel).toBe("失败");
  ```

- [ ] **Step 2: Run the focused test and verify RED**

  Run: `pnpm --dir desktop-client vitest run tests/run-center-presentation.test.ts`

  Expected: FAIL because the presentation module does not exist.

- [ ] **Step 3: Implement the minimal pure helpers**

  Export `RuntimeSourcePresentation`, `RuntimeStateVisual`, `parseRuntimeSource(source)`, and `runtimeStateMeta(phase)`. Parsing must preserve unknown sources without throwing and must only classify `github:` and `gitlab:` prefixes as provider icons.

- [ ] **Step 4: Run the focused test and verify GREEN**

  Run: `pnpm --dir desktop-client vitest run tests/run-center-presentation.test.ts`

- [ ] **Step 5: Refactor only after the focused test is green**

  Keep provider parsing independent from React and Electron so it can be reused by queue, board, and Inspector rendering.

### Task 2: Replace text-only runtime identity and status separators

**Files:**
- Modify: `desktop-client/src/main.tsx:35-100, 321-345`
- Modify: `desktop-client/src/palette.css:430-480`
- Modify: `desktop-client/src/layout.css:60-110`

- [ ] **Step 1: Add render helpers in `main.tsx`**

  Add a `RuntimeSource` component using `parseRuntimeSource` and `ProviderIcon`, and a `StateGlyph` component whose visible form is icon/rail based while retaining `aria-label` and `title` from `runtimeStateMeta`.

- [ ] **Step 2: Convert Queue to a single continuous stream**

  Flatten the existing phase groups in the stable order `active`, `ready`, `verify`, `attention`. Remove phase section headers and counts. Render each `EventRow` with a state glyph, provider icon, structured repository/work-item identity, result, next step, timestamp, and details affordance. Distinguish failed records from waiting-for-confirmation records within the attention phase.

- [ ] **Step 3: Convert Board headers to icon + count**

  Keep the four spatial columns, but remove visible text labels from column headers. Use the state glyph with an accessible label and retain the count as the only visible header metadata.

- [ ] **Step 4: Preserve selection behavior**

  Clicking any queue row or board card must continue to call `onSelect`; source parsing failures must fall back to plain text instead of breaking selection.

### Task 3: Clean workspace layout and Inspector behavior

**Files:**
- Modify: `desktop-client/src/main.tsx:96, 310-320`
- Modify: `desktop-client/src/palette.css:430-520`
- Modify: `desktop-client/src/layout.css:1-120`

- [ ] **Step 1: Default the Inspector to collapsed**

  Initialize `inspectorCollapsed` to `true`; selecting a runtime still mounts the Inspector and the restore affordance opens it on demand.

- [ ] **Step 2: Add the status-flow visual treatment**

  Add a low-contrast vertical rail to the queue, state-specific glyphs for active/ready/verify/attention, and a subtle active pulse. Keep the base surface neutral and avoid dashboard metric cards.

- [ ] **Step 3: Make narrow layouts readable**

  Set stable queue columns, `min-width: 0`, ellipsis for long repositories and titles, and responsive rules that collapse the Inspector below the list only at the existing narrow breakpoint.

- [ ] **Step 4: Check reduced-motion behavior**

  Disable the active pulse and arrival transition under `prefers-reduced-motion: reduce`.

### Task 4: Validate the desktop package

**Files:**
- No new production files; validate all touched files.

- [ ] **Step 1: Run the focused presentation test**

  Run: `pnpm --dir desktop-client vitest run tests/run-center-presentation.test.ts`

- [ ] **Step 2: Run the desktop test suite**

  Run: `pnpm --dir desktop-client test`

- [ ] **Step 3: Run typecheck**

  Run: `pnpm --dir desktop-client typecheck`

- [ ] **Step 4: Build the desktop package**

  Run: `pnpm --dir desktop-client build`

- [ ] **Step 5: Perform a visual smoke check**

  Open the desktop Run Center and verify: default queue is clean, no text-only status separators remain, GitHub/GitLab icons render, clicking a row opens Inspector, and board headers are icon-based.
