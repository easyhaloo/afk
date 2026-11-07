# ADR-0033: A modal in the agent's TUI belongs to AFK to dismiss

- Status: accepted
- Date: 2026-11-06

## Context

A verification run hung for seventeen minutes. The agent process was alive,
used almost no CPU, held no network connection, and the run record showed a
goal that had been sent and an agent that had never started.

The tmux scrollback held the answer. Codex had asked a question:

```
  Trust this folder? Codex can read, edit, and run files here, subject to your
  permission settings. Folder settings can run code automatically, even
  without a model request. Continue only if you trust these files. Your trust
  decision will be saved.

› 1. Trust and continue
  2. Quit

  enter continue · esc quit
```

The scrollback also showed the same question, and the same goal text after
it, eight times: Codex restarted behind the modal, restored the composer,
and asked again.

### Why the question appeared at all

Codex asks whether it may trust a directory it has not seen before. AFK runs
the implement step in the repository checkout, and the verification step in a
**worktree** — a second checkout with its own git root. The checkout was in
Codex's trusted list; the worktree was not, because its path is different
and Codex matches trusted paths exactly.

So the question appeared on every worktree AFK had not run an agent in
before, and the answer was remembered only for that one path.

### Why AFK did not answer it

AFK sends the goal with `send-keys`, then presses Enter twice, then checks
whether the composer still holds the goal and presses Enter again if it does.
The check reads the pane for Codex's empty-composer placeholder: a goal that
was typed but never submitted keeps the box filled, and the placeholder is
gone.

The placeholder is gone for two different reasons — the composer holds the
goal, or a modal is covering it — and the check cannot tell them apart. In
the second case it still presses Enter, which is right. But it pressed Enter
only three times, one second apart.

That budget assumed a modal that *holds* the keyboard, like the "Update
available" prompt the implementation already handled. The folder-trust
question is worse than that: accepting it restarts Codex, and the restart
takes seconds. Three presses were spent on the question and its aftermath,
and the goal was still in the composer when the budget ran out. The agent
waited for a goal that never arrived, and the runner waited for a signal
that never came.

The failure is silent in the same way the others are: AFK had already
logged "goal sent", and there was nothing after it to say that the goal had
never arrived.

## Decision

**A modal in the agent's TUI belongs to AFK to dismiss.**

AFK drives an interactive TUI it does not own, and that TUI opens modals
of its own. AFK cannot ask a person to answer them — nobody is watching the
run — so AFK has to answer them itself.

1. The submit budget must outlast a modal that *restarts* the agent. It is
   now a time window (30 seconds) rather than a small number of presses.
2. AFK names the modal it is answering and says so in the run log, so the
   gap between "goal sent" and "goal never arrived" is visible.
3. The composer's state stays the single source of truth for "has the goal
   arrived". A modal hides the placeholder, which reads as a filled
   composer, which is the conservative reading: AFK keeps pressing Enter
   rather than assuming the goal landed.

## Consequences

- A verification run in a fresh worktree no longer waits out the idle
  timeout for a goal that a modal swallowed.
- The run log names the modal, so the next occurrence is diagnosable from
  the log instead of from the pane scrollback.
- The budget is bounded: if the goal never arrives, AFK still gives up
  after the window and says so in a warning.
- AFK still does not pre-trust worktrees on the operator's behalf. Writing
  trust decisions into the agent's own configuration would make AFK
  responsible for a file it does not own, and it would only hide the
  problem that other modals still pose.
