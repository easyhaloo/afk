# TUI Operational Subviews Design

## Goal

Make the AFK terminal dashboard a concise, read-only operational surface for
viewing tasks, backlogs, projects, and a backlog board. The layout must work
for routine keyboard browsing without treating tracker labels as domain state.

The accepted interaction model is a collection of mutually exclusive
subviews. A user sees one list at a time, then opens a detail subview that
replaces the list. The TUI does not show a persistent side inspector or a
multi-view dashboard.

## Scope

The four top-level subviews are:

| Key | Subview | Primary data | List purpose |
| --- | --- | --- | --- |
| `1` | Tasks | active AFK sessions | inspect execution sessions and attach context |
| `2` | Backlogs | canonical backlog view models | scan backlog state, mode, and relationships |
| `3` | Projects | provider projects | browse available project contexts |
| `4` | Board | canonical backlog view models | scan operational backlog state using the same row grammar |

Each subview has a dedicated row presentation and contextual empty state.
Switching subviews resets selection to the first displayed item. Search is
local to the active subview.

## Navigation

The standard screen uses four vertical regions:

1. A one-line header containing the AFK identity, active subview navigation,
   item count, and any active search query.
2. A one-line context row showing the active subview and a short action hint.
3. A scrollable list whose height is calculated from the actual fixed rows.
4. A context-aware footer with repository context and relevant key bindings.

The decorative breathing separators and a duplicate list title are removed.
They consume rows without improving navigation. The selected list row uses a
stable marker and restrained background or foreground emphasis; it does not
use a rounded border that changes row height and wastes terminal width.

`Enter` opens the selected item in a detail subview. `Esc` or `b` returns to
the prior list with its selection and scroll context intact. The detail view
uses the same header/footer structure and never appears alongside a list.

## Row Grammar

Rows are single-line and never render descriptions or raw provider URLs. A
shared layout primitive reserves columns for selection, primary status, and
mode or source before the elastic title column. Low-value context is right
aligned or truncated.

Backlog and board rows show:

`selection | lifecycle state | execution mode | backlog ID + title | compact relationship summary`

The compact summary may contain parent backlog, dependency count, or tags. It
must not expose raw provider label encodings or infer state from labels.

Task rows show session state, task identifier/title, session/worktree context,
progress, and elapsed/relative time. Project rows show provider, project ID and
name, current branch or namespace, and a concise description.

Text truncation uses visual-width-aware helpers so Chinese, mixed-width text,
and Markdown-derived content do not break the column layout.

## Detail Subview

The detail subview replaces the list and presents metadata in grouped sections.
It does not introduce lifecycle controls.

Backlog detail groups the fields in this order:

1. Title, lifecycle state, and execution mode.
2. Parent backlog, dependencies, branch mapping, and provider reference.
3. Provider tags as non-semantic metadata.
4. Description rendered through the existing Markdown renderer.
5. Provider URL when available.

Task detail presents session, status, worktree, branch, and progress. Project
detail presents namespace/path, provider URL, recent commits, branches, and
tags. The only allowed actions remain browser opening through a provider
supplied URL and session attachment for task items.

## Responsiveness

The design targets 80-column terminals first.

| Width | Behavior |
| --- | --- |
| `< 80` | Preserve selection, status, mode/source, and truncated title; hide the summary column. |
| `80-119` | Use all list columns with bounded metadata. |
| `>= 120` | Allocate additional title and relationship-summary width; do not add a parallel inspector. |

The layout computes list viewport height from the rendered fixed chrome rather
than using the existing hard-coded `height - 4` approximation. Long titles,
URL values, and descriptions are truncated in lists and wrap only in detail.

## Read-Only Boundary

The TUI remains a management and viewing surface. It must not claim work,
change lifecycle state, alter labels/tags, launch or kill workers, create
branches, merge changes, or write to a backlog provider. `o` opens only the
canonical provider-supplied `webUrl`; task attachment remains an existing local
navigation behavior, not a lifecycle mutation.

## Components

- `AppContent`: derives visible items, owns keyboard navigation, calculates
  layout metrics, and switches between list and detail subviews.
- `Header`: renders the active subview navigation and concise context.
- `Footer`: receives active view and detail/search state to render relevant
  shortcut hints.
- List views: render data-specific content through a shared row grammar and
  visual-width truncation helpers.
- `DetailScreen`: renders one full-screen detail subview with grouped metadata
  and only read-only actions.

No provider or workflow service API changes are required.

## Errors and Empty States

Provider loading errors remain isolated to the data hook and surface as a
notification rather than an unhandled rejection. Empty states identify the
active subview, for example “no running tasks” or “no backlogs”. Missing URLs
show an unavailable value and `o` produces the existing warning notification.

## Verification

Automated tests cover:

- view switching, selection, search, Enter detail, and Escape/back return;
- active-view and detail footer hints;
- data-specific row columns and no raw description on list rows;
- no lifecycle mutation handler is reachable through TUI input;
- CJK and long-text truncation;
- 80, 100, 120, and 160 column layout snapshots or PTY captures;
- browser opening and task attachment regressions.

Manual validation covers terminal rendering with empty, populated, blocked,
and dependency-bearing backlogs in each responsive tier.
