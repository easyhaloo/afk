# Remove Sidebar Refresh Status Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the lower-left “刷新状态” button from the desktop client's sidebar without changing any other refresh behavior.

**Architecture:** Delete only the sidebar button JSX in `desktop-client/src/main.tsx`. Keep the shared `refresh` function, top-right refresh control, command-sheet refresh action, and settings entry unchanged.

**Tech Stack:** React, TypeScript, Vite, Vitest.

---

### Task 1: Remove the sidebar refresh status action

**Files:**
- Modify: `desktop-client/src/main.tsx:251-254`

- [ ] **Step 1: Remove the lower-left refresh button**

Delete the button whose label is `刷新状态` or `正在刷新…` from `.sidebar-bottom`, leaving the settings button as the only remaining sidebar-bottom action.

- [ ] **Step 2: Verify other refresh entry points remain**

Run `rg -n "刷新状态|正在刷新|top-actions|重新读取|runtime-refresh" desktop-client/src/main.tsx` and confirm only the unrelated top-right, command-sheet, and agent-page refresh actions remain.

- [ ] **Step 3: Run desktop validation**

Run `pnpm typecheck` and `pnpm test` from `desktop-client/`.
