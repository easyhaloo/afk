# TUI Parallel Kanban Board Design

## Goal

Replace the Board subview's flat backlog list with a read-only, parallel
Kanban view. It must make backlog flow visible at a glance while preserving
the existing provider-neutral data model, detail subview, search, browser
opening, and global dashboard chrome.

## Scope

The Board renders four primary lifecycle lanes in this order:

```text
Ready -> In Progress -> Verification -> Merge Ready
```

`Rework` and `Blocked` are combined into a conditional `Attention` column,
with red/yellow card-level distinction. `Done` is a conditional archive
column. Both remain reachable through left/right navigation and are shown in
the global status strip, but do not consume normal pipeline width when they
are empty or not focused.

The TUI remains read-only. It does not claim work, transition backlog state,
change execution mode, mutate labels, or merge changes.

All lifecycle and execution-mode values use a compact colored icon vocabulary.
The Board owns a named flow summary (`Ready`, `Processing`, `Verification`,
`Merge`, `Attention`, and `Done`) so the workflow remains readable without
requiring a separate legend row. On narrow terminals the summary switches to
short labels to keep Attention and Done counts visible.

## Layout

The existing fixed dashboard shell remains unchanged:

```text
Header
Context row
Kanban viewport
Footer
```

Within the viewport, each primary lane has:

1. A colored lifecycle icon and item count.
2. A restrained divider.
3. Two-row backlog cards: icon/state line and truncated title. Parent and
   dependency details are intentionally deferred to the detail subview.

A card contains the backlog ID, a visual-width-truncated title, execution
mode. The full description, parent, dependencies, branch, provider reference,
tags, and URL stay in the
existing detail subview.

The selected card has a stable marker and high-contrast state treatment. A
lane must never grow beyond the allocated board viewport or displace the
global header/footer.

## Responsive Behavior

The Kanban view uses lane windows instead of rendering unusably narrow cards.

| Terminal width | Visible lanes | Behavior |
| --- | --- | --- |
| `>= 154` | Four primary lanes | Equal-width core pipeline lanes shown in parallel. |
| `100-153` | Three | Focused lane plus immediate neighbors; left/right shifts the window. |
| `< 100` | One | Focused lane fills the viewport; a compact pipeline strip shows every lane and count. |

The focused lane is derived from the selected backlog. Empty primary lanes
remain visible for lifecycle context but are skipped by left/right navigation.
When an Attention or Done item is selected, that auxiliary column expands to
the full board width so it can be inspected without reserving a permanent
empty column.

## Navigation

Board navigation is state-aware rather than based on a flattened list order:

| Key | Action |
| --- | --- |
| `Left` / `Right` | Move to the adjacent non-empty lifecycle lane, preserving the card ordinal where possible. |
| `Up` / `Down` | Move within the focused lane. |
| `g` / `G` | Move to the first / last card in the focused lane. |
| `Enter` | Open the existing detail subview. |
| `o` | Open the selected backlog's provider URL. |
| `b` / `Esc` | Return through normal dashboard navigation. |
| `q` | Exit the application outside search input mode. |

`/` filters the canonical backlog collection before grouping. Matching cards
remain in their normal lifecycle lanes, and lane counts reflect the filtered
set.

## Components and Data Flow

Introduce a small pure board model alongside `BoardView`:

```text
BacklogViewModel[]
  -> groupBacklogsByState()
  -> BoardColumn[]
  -> BoardView / BoardCard
```

The model owns state grouping, primary/auxiliary column composition,
visible-lane-window calculation, and selection navigation targets. `AppContent` delegates arrow and home/end keys
to these pure helpers only while `currentView === 'board'`; Tasks, Backlogs,
and Projects retain their existing list navigation.

`BoardView` owns terminal presentation only. It receives the grouped model,
the selected backlog ID, and viewport dimensions. It calculates each lane's
visible card slice from the selected card's position, without adding provider
state or writable capabilities to the view.

## Errors and Empty States

When no backlogs match, the viewport displays `no matching backlogs` while
retaining the pipeline strip. Missing optional parent
or dependency data uses the existing compact placeholder. Provider failures
remain owned by the data hook and surface through the existing notification
path.

## Verification

Automated coverage must include:

- direct mapping of all seven states to primary, Attention, and Done columns;
- selected-card movement within a lane and across lanes;
- compact, medium, and wide lane-window calculations;
- card title truncation and auxiliary-state summaries;
- `Enter`, `o`, search, `b`/`Esc`, and global `q` regressions;
- real PTY rendering at 80, 120, and 160 columns, proving Header/Footer stay
  visible and cards do not escape the board viewport.

Run focused Board and PTY tests, the full suite, typecheck, build, and
`git diff --check` before integration.
