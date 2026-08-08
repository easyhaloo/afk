# TUI Live Task Cockpit Design

## Goal

Redesign the AFK TUI around observing active execution. The primary screen
must answer, at a glance, which tasks are running, what the focused task is
doing now, whether it is healthy, and what changed most recently.

## User priority

The user's normal workflow is monitoring active tasks, not managing static
backlogs. The default view therefore focuses on the runtime task projection;
Backlogs, Projects, and the Kanban Board remain available as secondary
subviews and detail destinations.

## Design direction

The visual language is `Quiet Signal` with `Console Flow` semantics:

- deep neutral terminal background with one mint live signal;
- hairline separators and compact typography instead of nested cards;
- a stable focus treatment instead of flashing or animated noise;
- timestamps, event kinds, command summaries, test outcomes, and diagnostics
  as structured activity data;
- warning and blocked states use amber/red accents that remain visible when
  animation is disabled or the terminal is color-limited.

The design must work in an 80-column terminal first, then add context at
120+ columns. It must not depend on Nerd Fonts, external image assets, or
true-color support.

## Fixed shell

Every screen retains three independent regions:

```text
Header  — global identity, live health, view navigation
Body    — one active task cockpit or one secondary subview
Footer  — path/branch context and context-sensitive shortcuts
```

The shell owns terminal dimensions and prevents the Header/Footer from being
displaced by body content. The Body owns only the active subview and its
optional search prompt.

## Header

The Header is a compact operational status bar, not a duplicate help row.

At wide widths it contains:

```text
AFK LIVE · 3 running · 1 attention     1 Tasks  2 Backlogs  3 Projects  4 Board
```

At narrow widths it reduces to:

```text
AFK · ●3 !1                            1 2 3 4
```

The active view is highlighted. Counts describe the current read model:
active tasks from the local runtime projection, attention from blocked/stale
tasks, and provider-backed backlog/project counts. The Header never renders
per-view action hints.

## Live task cockpit

When `Tasks` is active and at least one task exists, Body renders a focused
task cockpit:

```text
┌ task identity / current phase ───────────────────────┬ queue ───────┐
│ status · mode · sandbox · branch · worktree           │ #96 verify   │
│ progress + elapsed time                               │ #94 ready    │
│ claimed → implement → verify → handoff               │ #91 blocked  │
│                                                       │              │
│ recent activity                                       │              │
│  04:20 tool  apply_patch · 1 file                    │              │
│  04:22 test  4 passed · 0 failed                     │              │
└───────────────────────────────────────────────────────┴──────────────┘
```

The focused task is selected from the active task list. `↑↓` moves focus;
the queue remains visible and updates immediately. The task identity line
contains the backlog ID and concise title. The context line exposes phase,
execution mode, sandbox provider, agent provider, branch, worktree, and
session only when available. Optional values collapse to a single placeholder
instead of producing empty labels.

The activity stream is a structured runtime projection, not raw tmux output.
Each event has a timestamp/relative age, category, and short message. The
initial categories are `agent`, `tool`, `test`, `state`, `qa`, and `error`.
The stream is read-only and bounded to the viewport; `Enter` opens the full
task detail/diagnostics view and `o` opens the diagnostics path when present.

If no active task exists, Body renders a calm empty state with the latest
runtime refresh time and a shortcut to Backlogs; it does not fabricate a
running task or fall back to tmux sessions.

## Secondary views

`Backlogs`, `Projects`, and `Board` remain independent subviews. Their rows
reuse the same status/mode vocabulary and selected-row treatment as the task
cockpit. The Board remains a parallel lifecycle Kanban, but it is no longer
the default visual center.

Detail screens preserve full semantic context: description, parent backlog,
dependencies, provider reference, branch, tags, URL, runtime diagnostics,
and recent repository data. No detail-only metadata is duplicated in the
compact queue.

## Semantic vocabulary

Use text plus color/icon, never color alone:

| Meaning | Icon | Color | Examples |
| --- | --- | --- | --- |
| healthy/running | `●` | mint/cyan | active task, live heartbeat |
| processing | `▶` | yellow/amber | implementation in progress |
| verification | `◌` | magenta/blue | QA or acceptance checks |
| waiting/ready | `○` | cyan/gray | queued backlog |
| human attention | `◇` | amber | HITL/manual review |
| blocked/stale/error | `!` | red | timeout, conflict, failure |
| completed | `✓` | green | done/verified |

Execution mode remains explicit through `⚙`/`◇` plus a text label in detail;
the compact cockpit may show the icon and `AFK`/`HITL` abbreviation together.

## Dynamic behavior

Dynamic feedback communicates state change without becoming a distraction:

- active heartbeat: a subtle one-step color pulse no faster than once per
  second;
- phase transition: selected phase underline changes and the event stream
  receives one `state` event;
- new activity: append with a short fade/slide-in, never reflow the header;
- blocked/error: stable red marker and one notification; no continuous blink;
- stale heartbeat: downgrade the live marker to amber/red after the existing
  runtime threshold;
- refresh: preserve selected task by `runId` when data reloads.

Animation must degrade to static color/marker changes when `NO_COLOR` or a
non-interactive output is detected. No timers may keep the process alive after
the TUI exits.

## Responsive rules

| Width | Body layout |
| --- | --- |
| `< 80` | focused task only; queue becomes a one-line `+N queued` summary; activity shows latest two events |
| `80–119` | focused task main column + compact queue; activity shows latest four events |
| `≥ 120` | focused task main column + queue column; full structured activity context |

The Header and Footer are always one row. Long titles, branches, and event
messages truncate by display width. Full values remain available in Detail.

## Data boundaries

The cockpit consumes a local runtime task projection and an optional bounded
activity projection. It must not read tmux directly, claim backlogs, mutate
provider state, or infer lifecycle from labels. A new `TaskActivity` read
model should be serializable and provider-neutral:

```ts
interface TaskActivity {
  id: string;
  taskRunId: string;
  at: Date;
  kind: 'agent' | 'tool' | 'test' | 'state' | 'qa' | 'error';
  message: string;
  detail?: string;
}
```

The existing `TaskRuntimeManager` remains the source of truth for active task
identity and health. Activity storage may use the existing local filesystem
diagnostic/status files; no database or middleware dependency is introduced.

## Keyboard behavior

- `↑↓`: focus active task / queue item;
- `Enter`: open focused task detail;
- `o`: open task diagnostics or provider URL;
- `1–4`: switch subviews;
- `/`: search the active subview;
- `Ctrl+D`: toggle debug overlay;
- `r`: refresh runtime/provider read models;
- `q`: exit outside search input mode;
- `b`/`Esc`: navigate back from detail/search according to existing policy.

The help dialog and Footer must expose only the shortcuts valid in the current
context. No shortcut may be documented in two adjacent shell rows.

## Verification

Coverage must include:

- task cockpit selection and preservation across refresh;
- event projection mapping and display-width truncation;
- empty, active, stale, blocked, and completed task states;
- 80/100/120/160-column PTY layout with fixed Header/Footer;
- narrow queue collapse and wide activity expansion;
- `Enter`, `o`, `/`, `r`, `q`, and `Ctrl+D` regressions;
- existing Backlogs/Projects/Board read-only and navigation tests;
- full suite, typecheck, build, and `git diff --check`.

No provider mutation or compatibility wrapper is added as part of this UI
redesign.
