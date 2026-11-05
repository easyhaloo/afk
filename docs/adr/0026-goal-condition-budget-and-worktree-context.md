# ADR-0026: The goal condition budget, and context in the worktree

- Status: accepted
- Date: 2026-11-05

## Context

Every QA run of PRD #27 that failed, failed the same way — and the failure was recorded as something it was not.

Claude Code's TUI refused the goal with one line:

```
⎿  Goal condition is limited to 4000 characters (got 5730)
```

and then did nothing. No task, no output, no tokens. AFK waited out the 1,800-second idle timeout and recorded `AGENT_IDLE` — "the QA agent was silent for 1800 s". The actual reason was never in the failure record, the backlog comment, or `afk log`.

The measurements were exact:

| Slice | Description length | Goal length | Result |
| --- | --- | --- | --- |
| papilot#2 | 1,276 | 3,926 | change request published |
| aiapi#8 | 1,267 | 3,917 | change request published |
| llm-wiki#29 | 1,017 | 3,667 | change request published |
| k-base#3 | 1,496 | 4,146 | silent |
| open-api#2 | 3,088 | 5,738 | silent |
| console#4 | 3,816 | 6,466 | silent |
| k-base#9 | 5,040 | 7,690 | silent |
| atlas#7 | 6,083 | 8,733 | silent |

Three successes, five failures, and the boundary sits at a description of about 1,350 characters. The fixed overhead was constant at about 2,650 characters.

The cause was one line of code. `packages/runtime/src/application/runners/qa-runner.ts` built the goal as

```ts
const goal = `${qaStep.prompt.replaceAll('{iid}', id)}\n\nBacklog title: ${backlog.title}${description ? `\nBacklog description:\n${description}` : ''}`;
```

which inlined the whole issue description — the full acceptance-criteria list — into the goal condition. `packages/runtime/src/application/workflow-engine.ts` did the same on the implementation path.

Two structural facts made this worse than a long prompt:

1. **AFK did not know the limit existed.** Nothing in the repository knew that the agent TUI enforces a 4,000-character goal condition. The number was a property of an external tool, discovered only by being wrong.
2. **The refusal was invisible.** The TUI rejects the goal and then sits there. AFK has no channel to learn why, so the run continued until the idle timeout, and the failure was filed as a timeout — a symptom standing in for a cause.

One accident of routing hid the defect from the implementation path: `buildBatchPrompt` strips the `/goal` prefix, so a batch run delivers the goal as an ordinary message and the limit does not apply. `buildInteractivePrompt` keeps it, so only QA — which runs interactively — hit the wall. Implementation was lucky, not correct.

## Decision

### The limit is a provider capability, and AFK asks the provider

`AgentProvider` gains an optional `promptLimits` (`packages/runtime/src/domain/agents/types.ts`):

```ts
export interface AgentPromptLimits {
  goalConditionMaxChars?: number;
}
```

Claude Code declares `4000` next to its other capabilities, because that is the limit its TUI enforces. AFK no longer guesses a number: it reads the limit from the provider that will receive the prompt.

**The limit applies to the goal channel only.** A prompt that is not delivered as a `/goal` command has no goal-condition limit, whatever the provider's composer accepts. `usesGoalChannel` decides this from the prompt itself, so the rule cannot drift away from what is actually sent: batch mode strips `/goal` and is therefore not measured against the goal limit.

**A provider that declares no limit is measured against the strictest limit AFK knows of** (`DEFAULT_GOAL_CONDITION_MAX_CHARS = 4000`). The default is deliberately pessimistic. A provider that would have accepted a longer goal loses one prompt and one clear error message; a provider that would have refused it loses half an hour of idle timeout and still learns nothing. The pessimistic default is the cheaper mistake.

### The content goes into the worktree, the prompt carries a pointer

A truncated description is not a fix: it silently drops acceptance criteria, and the agent then reports on criteria it never saw. Instead, the prompt stops carrying the description at all.

The backlog description is written into the worktree as `.afk/backlog-context.md`, and the goal keeps:

- the template's own task statement — the task is never dropped;
- the backlog title;
- a pointer: *"Backlog context: the acceptance criteria and the full requirement text are written to `.afk/backlog-context.md` in this worktree. Read that file before you start."*

The prompt length is now decoupled from the description length. The agent is already in the worktree and can read a file; the criteria are still delivered verbatim, in full.

`.afk/` is the directory AFK already uses for its own runtime artifacts (the completion signal is `.afk-signal.json`, the artifact manifest is `.afk/artifacts.txt`). The context file therefore never enters a change request — the branch provider excludes `.afk` from the commit — and never makes a worktree look dirty: `multi-repository-preparer.ts` already treats `.afk` as a runtime artifact when it reads `git status`.

Both paths are changed: the QA runner writes the file into the QA worktree, and the implementation path writes it into the worktree of the step it is about to run.

### The prompt is built from labelled pieces

`execution-protocol.ts` now builds a prompt from `PromptSegment`s — a label and a text — instead of concatenating strings. `buildExecutionPromptSegments` returns the goal's own pieces plus the completion protocol; `assemblePrompt` joins them.

The label is not decoration. When a prompt turns out to be too long, the label is what says which piece is responsible: the task statement, the backlog title, the context pointer, the rework context, or the completion protocol.

### A problem that dispatch can find is found before dispatch

The final prompt is measured against the provider's declared limit before the agent is started. Over the limit, the run fails immediately with the structured diagnosis of ADR-0025:

- `code: prompt_budget_exceeded`;
- the actual length of the goal condition and the limit it crossed;
- the piece that crossed the limit, and the length of every piece;
- the suggested action.

This is the same discipline ADR-0025 applied to the environment probe: a fact that is known before the agent runs must not be reported as an agent timeout after half an hour. `afk log <runId>` now shows the cause, the length and the limit.

`ProcessAgentProvider.createExecution` refuses an over-long goal as well. The runner check produces the readable diagnosis; the provider check is the backstop that makes it impossible for any caller to dispatch a goal the provider would refuse.

### The tmux comment was wrong; the behaviour was not

`tmux.ts` claimed the prompt is sent "as a single line (no embedded newlines which would cause premature submission in the TUI)". The claim was false — a prompt carrying a description has been multi-line all along — but the concern did not materialise.

Verified against a raw-mode tmux pane: `tmux send-keys -- "A\nB"` transmits the newline as a line feed (0x0A), not as a carriage return (0x0D); a carriage return shows up as `^M`. The composer submits on the carriage return that `C-m` sends, so a newline in the prompt reaches the composer as text.

The production evidence agrees: the TUI measured the *whole* multi-line goal ("got 5730" for a 3,088-character description), which it could only do if the entire text was in the composer at once. If the newline had submitted the goal half-way through, the count would have been the length of the first line.

The comment was corrected to state what is actually true.

## Consequences

- A QA run over a detailed slice no longer dies on a silent refusal. The description is in the worktree and the goal stays small.
- `prompt_budget_exceeded` is a new failure code in `RunFailureReasonCode`, classified as `infrastructure`: the prompt AFK built is longer than the provider accepts.
- The prompt a provider receives changed shape: the goal's pieces are separated by blank lines, and the interactive prompt puts the completion protocol on its own paragraph instead of after a space. The content is the same.
- The goal no longer contains the acceptance criteria. An agent that does not read `.afk/backlog-context.md` verifies nothing — the pointer is the only thing that makes the criteria reachable, so the pointer has to stay in the goal.
- `.afk/backlog-context.md` is written on every implementation and QA step that has a description. It is runtime state, not work, and it is never committed.

## Alternatives considered

- **Truncate the description to fit.** Rejected: it drops acceptance criteria silently, and the agent then reports on a requirement it never saw. The defect was that the content and the prompt shared one channel, not that the content was too long.
- **Keep the description inline and shorten the protocol.** Rejected: it moves the boundary instead of removing it. The next detailed slice crosses it again.
- **One global prompt limit for every provider.** Rejected: the limit belongs to the goal channel of one provider. A global number would refuse prompts that are perfectly acceptable on the message channel.
- **Ask the provider at runtime.** Rejected: the limit is a property of the provider's TUI, not of a running session. Asking per run would mean parsing a TUI's error output, which is what this ADR removes the need for.
- **Let the run fail and improve the timeout message.** Rejected: the run cannot fail faster than the refusal is detected. The point is to detect it before dispatch.
