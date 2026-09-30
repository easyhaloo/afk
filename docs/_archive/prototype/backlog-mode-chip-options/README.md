# Backlog mode chip — variant comparison

Visual prototype for evaluating four expressions of the Backlog row's
"execution mode" chip (AFK 自动 / HITL 人工), now that the shipped
icon + soft-bg chip feels too prominent next to the existing state pill.

## How to view

```bash
open docs/prototype/backlog-mode-chip-options/index.html
# or
npx serve docs/prototype/backlog-mode-chip-options
```

## What's here

Seven variants rendered against the same three backlog rows (登录态切换 /
kg 演示 / 支付回调), reusing the production color tokens
(`--run-soft`, `--attention-soft`, `--muted`, etc.) so the side-by-side
comparison matches what shows up in `BacklogPage`.

| # | Name | Strategy | Tradeoff |
|---|------|----------|----------|
| 1 | Shipped (chip + icon) | 12px lucide icon + soft bg + text | Reads as a second state dimension; icon/text duplicate |
| 2 | **dot + text** *(recommended)* | 6px dot (matches state pill) + colored text, no bg | Same visual rhythm as state pill, lowest disturbance |
| 3 | Monospace abbreviation | 9px DM Mono `AFK` / `HITL` with soft bg | Most compact; relies on user memory of the abbreviation |
| 4 | Inline text | 5px muted dot + muted text, no chip | Minimal weight but loses the AFK/HITL color signal |
| 5 | Left-edge colored bar | 3px row border colored by mode + tiny inline swatch | Pure geometric, no chip at all; HITL-heavy lists can read as a warning wall |
| 6 | Title tint | Mode color bleeds into the row title; metadata row keeps a soft dot+text | Most semantic — title color = mode color; HITL conflicts with `done` state pill rhythm |
| 7 | Left-side icon marker | 28×28 soft square at row start (Bot / Hand) + light dot+text in metadata | Strong visual anchor at row start; eats ~28px of horizontal real estate and competes with the run button |

The page also includes a side-by-side comparison table at the bottom that
puts all seven variants on the same row so direct scanning is easy.

## Recommendation

Variant 2 — dot + text — solves the "icon + text 突兀" complaint without
losing the AFK/HITL color signal. It mirrors the existing `state-pill`
exactly, so the eye reads them as the same kind of thing at the same
weight, just in a different color.

Variants 5, 6, and 7 are worth a look as alternative design philosophies
(geometric / semantic fusion / icon-anchor) but each carries a real cost
that V2 doesn't.
