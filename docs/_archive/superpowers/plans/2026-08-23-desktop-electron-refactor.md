# Desktop Electron Refactor Implementation Plan

> **For agentic workers:** Execute this plan task by task with tests before implementation.

**Goal:** Restructure `desktop-client` into standard Electron main/preload/renderer layers with shared contracts, testable services, and isolated workflow graph logic without changing the current product behavior.

**Architecture:** The main process becomes a small bootstrap that registers typed IPC handlers over service modules and adapters. A dependency-free `shared/` contract is consumed by preload and renderer. Renderer features are split by workflow/replay/terminal/settings, while graph normalization and routing are pure functions with diagnostics.

**Tech Stack:** Electron 35, TypeScript, React 19, Vite, js-yaml, Vitest.

### Tasks

1. Add repository constraints and desktop package test/typecheck configuration.
2. Add failing tests for workflow validation, graph dependency handling, and IPC argument contracts.
3. Extract shared DTOs and the typed preload API.
4. Extract process, workspace, resource, workflow, runtime, and appearance services.
5. Replace `electron/main.ts` with bootstrap, window, security, and IPC registration modules.
6. Extract graph model functions and make malformed templates return diagnostics.
7. Split renderer page/features while preserving CSS and user-visible behavior.
8. Add desktop CI checks and ignore generated outputs; run typecheck, tests, and build.
