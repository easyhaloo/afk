# ADR-0014: Dual Structured Output Channels for Interactive and Batch Modes

## Status

Accepted

## Context

AFK needs to detect when an agent completes a goal (`goal_complete`) or is ready for context handoff (`handoff_ready`). This is the **structured output** problem: how does the agent communicate structured data back to the runner?

Two agent execution modes exist in AFK:

1. **Interactive mode** — agent runs inside a tmux session (TUI). Used for long-running tasks, human-in-the-loop, complex workflows.
2. **Batch mode** — agent runs with `--print --output-format stream-json` (no TUI). Used for pure tasks, CI pipelines, simple automation.

Each mode has fundamentally different stdout/stderr characteristics, making a single output channel impractical.

## Decision

AFK uses **two distinct structured output channels**, one per mode:

### Interactive Mode → Signal File (`.afk-signal.json`)

The agent is instructed via prompt to write a JSON signal to `.afk-signal.json` on completion:

```
When done, output the following to stdout:
<goal_complete>{"summary":"..."}</goal_complete>
```

The runner polls the file every 2s. The write is atomic (temp + rename).

| Signal type | Meaning |
|------------|---------|
| `goal_complete` | Any agent step completed; QA supplies `kind: "qa"` and `result: "PASS" | "FAIL"` in its payload |
| `handoff_ready` | Agent ready for context handoff (summary in payload) |
| `timeout` | Watchdog fired (written by watchdog process, not agent) |

**Why not stream?** In interactive mode, the agent runs in a tmux TUI — there is no stdout stream to parse. The session persists to `~/.claude/projects/.../sessions/<id>.jsonl`, but that file is only accessible on the machine where the agent ran.

### Batch Mode → Event Stream Parsing

The agent runs with `--print --output-format stream-json`. Output is newline-delimited JSON:

```json
{"type":"result","result":"<goal_complete>{\"type\":\"goal_complete\",\"kind\":\"task\",\"summary\":\"...\"}</goal_complete>"}
{"type":"usage","usage":{...}}
```

The runner preserves the task's `/goal` prompt and appends this completion
protocol before batch execution. It captures stdout and parses `result` events
for the single structured output tag. QA uses the same tag with
`{"type":"goal_complete","kind":"qa","result":"PASS" | "FAIL",...}`.

**Status:** Implemented by `StreamingAgentExecution`. It buffers JSONL records
across stdout chunks, requires a structured completion result, and reports
malformed output, non-zero exits, and timeouts as failed executions.

## Consequences

### Positive
- Each mode uses the most natural output channel for its execution environment
- Interactive mode signal file is recoverable after crash (process dies, file persists)
- Batch mode is higher-throughput (no polling, just stream consumption)
- Clear separation of concerns — runner doesn't need to know which mode it's in

### Negative
- Two code paths for the same logical operation (completion detection)
- Handoff coordination in interactive mode still requires signal file (can't use stream)

## References

- `src/lib/core/io/signal.ts` — interactive mode signal file implementation
- `src/lib/sandbox/providers/local.ts` — interactive mode `LocalAgentExecution`
- `src/lib/sandbox/index.ts` — sandbox provider factory
