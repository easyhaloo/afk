# Backlog Detail Deduplication Design

## Goal

Reduce repeated and low-value information in the desktop Backlog detail
drawer while preserving the data and actions users need to understand and
open a work item.

This is an incremental refinement of
`docs/superpowers/specs/2026-09-08-backlog-detail-drawer-design.md`. It does
not change how the drawer opens, closes, loads data, or launches external
links.

## Problems

The current detail header and content repeat or reserve space for information
that does not improve decision-making:

- Execution mode is represented by both a standalone icon and a text tag.
- The `Backlog` prefix repeats context already established by the page and
  drawer heading.
- An empty runtime section displays a placeholder even when no runtime exists.
- Optional metadata rows display default or empty values such as `—`,
  `无标签`, or `无依赖`.

These elements make the drawer longer and weaken the visual hierarchy between
the work item title, description, and meaningful metadata.

## Information Hierarchy

### Header

The header remains the primary summary and contains:

1. The existing `BACKLOG DETAIL` eyebrow.
2. The work item title.
3. One compact metadata line containing:
   - Backlog ID.
   - State pill.
   - One execution-mode tag with its icon and text.

The standalone `Backlog` prefix and standalone execution-mode icon are
removed. State and execution mode remain visually distinct and accessible by
text, not color alone.

### Description

The description follows the header and remains unchanged. Markdown rendering,
task lists, links, code blocks, and Mermaid handling are outside this change.

### Runtime

The runtime section is conditional:

- Render it when `summary.runtime` or `summary.activeRun` contains meaningful
  execution information.
- Omit the entire section when neither value exists.
- Do not render a `暂无规范化运行记录` placeholder.

When runtime data exists, the current status and diagnostic content remain
available without duplicating the same status in multiple adjacent blocks.

### Metadata

Metadata rows follow these visibility rules:

- Always show `Provider 引用` when it has a non-empty value.
- Always show `分支` when it has a non-empty value.
- Show `父工作项` only when `parentId` exists.
- Show `执行基线` only when `baseBacklogId` exists; do not display the
  `默认目标分支` fallback.
- Show `标签` only when at least one tag exists.
- Show `依赖` only when at least one dependency exists.
- Omit the metadata container if none of its rows are visible.

The drawer must not display `—`, `无标签`, or `无依赖` solely to preserve a
fixed number of rows.

### External Action

The existing external-browser action remains unchanged:

- Render the button when `webUrl` exists.
- Retain the existing missing-link message when `webUrl` does not exist,
  because it explains why the primary action is unavailable rather than
  duplicating work item data.

## Component Changes

- Keep data fetching and selection state in `BacklogPage`.
- Keep presentation and conditional visibility in `BacklogDetailDrawer`.
- Derive visible metadata rows inside the drawer from the existing
  `BacklogRuntimeSummary`; do not add new DTO fields or IPC methods.
- Reuse existing Lucide icons, state labels, CSS variables, and drawer layout
  tokens.
- Remove CSS selectors that become unused after the standalone prefix or mode
  mark is removed from the drawer, without changing list-row styling.

## Accessibility

- The state and execution mode continue to expose readable text.
- The execution-mode icon is decorative and uses `aria-hidden="true"`.
- The drawer keeps its existing dialog role, labelled title, close-button
  focus, Escape handling, and backdrop dismissal.
- Conditional removal must not alter focus order or leave hidden interactive
  elements in the document.

## Testing

Focused component tests verify that:

- The selected work item still opens and closes correctly.
- Execution mode text appears once in the drawer.
- The standalone `Backlog` status prefix is absent.
- The runtime section is absent when no runtime or active run exists.
- Optional metadata rows are absent for empty/default values.
- Optional metadata rows appear when their corresponding values exist.
- Existing external-link behavior remains intact.

The Electron E2E test verifies that clicking a Backlog row opens the refined
drawer and that the visible summary contains one state indicator and one
execution-mode indicator.

## Non-Goals

- Changing Backlog list cards or filters.
- Changing runtime reconciliation or execution behavior.
- Adding metadata collapse controls.
- Reordering or changing the shared Backlog DTO.
- Redesigning Markdown content or the external-link action.

## Acceptance Criteria

1. The drawer shows Backlog ID, state, and execution mode once in the header.
2. Execution mode uses one combined icon-and-text tag.
3. Empty runtime content does not reserve space.
4. Empty or default optional metadata rows are omitted.
5. Populated optional metadata remains visible.
6. Drawer accessibility and external-link behavior remain unchanged.
7. Focused unit tests, desktop typecheck, and the Backlog drawer E2E test pass.
