# Backlog PR Association and Description Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AFK-created PRs link back to their Backlog issue, expose the durable PR metadata in Backlog DTOs and the desktop drawer, and use a dedicated PR description instead of copying the PRD verbatim.

**Architecture:** The change provider will generate a provider-compatible PR body containing a closing keyword and concise execution metadata. The backlog provider will rehydrate the associated change from the durable QA branch (`<backlog branch>-qa`) after terminal QA states, then project that metadata through the CLI and Electron contracts. The renderer will show the actual PR number/state and open its URL.

**Tech Stack:** TypeScript, Vitest, Electron shared DTO validation, React.

---

### Task 1: Add change metadata and PR body behavior tests

**Files:**
- Modify: `src/infrastructure/tracker/changes/tracker-adapter.test.ts`
- Modify: `src/domain/backlog/tracker-adapter.test.ts`

- [x] **Step 1: Write failing tests** for generated PR body/closing keyword and terminal backlog projection of the associated change.
- [x] **Step 2: Run the focused Vitest files and verify they fail for the missing behavior.**
- [x] **Step 3: Implement the minimal domain/infrastructure behavior.**
- [x] **Step 4: Run the focused tests and verify they pass.**

### Task 2: Extend shared DTO validation

**Files:**
- Modify: `desktop-client/shared/backlog-contract.ts`
- Modify: `desktop-client/tests/shared/backlog-contract.test.ts`

- [x] **Step 1: Add a failing parser test for `changeRequest`.**
- [x] **Step 2: Run the focused shared-contract test and verify failure.**
- [x] **Step 3: Add the optional provider-neutral change request shape and parser validation.**
- [x] **Step 4: Run the focused test and verify it passes.**

### Task 3: Display the real PR in the desktop drawer

**Files:**
- Modify: `desktop-client/src/features/backlog/BacklogDetailDrawer.tsx`
- Modify: `desktop-client/tests/backlog-page.test.tsx`

- [x] **Step 1: Add a failing renderer test for the PR number/link.**
- [x] **Step 2: Run the focused renderer test and verify failure.**
- [x] **Step 3: Render the actual PR metadata and make the link open through the existing external-url callback.**
- [x] **Step 4: Run the focused renderer test and verify it passes.**

### Task 4: Verify the complete focused regression set

- [x] **Step 1: Run all changed-domain and desktop contract tests.**
- [x] **Step 2: Run TypeScript typechecks for the CLI and desktop packages.**
- [x] **Step 3: Review the diff and preserve unrelated user changes.**
