# Agent Execution Boundary Design

## Goal

Make automatic AFK execution depend on a provider-built command and a typed
`AgentExecution` result, rather than on tmux pane state, statusline files, or
legacy signal files.

## Problem

The failed run of backlog `#60` showed that the current local sandbox owns both
environment setup and Claude startup. It starts a hard-coded Claude command,
uses statusline-file presence as readiness, then checks the same file again
before sending the goal. The `AgentProvider` command is ignored in interactive
mode. A file written before an agent is ready cannot prove that the agent can
receive work.

## Decisions

1. `SandboxProvider.create()` provisions an environment only. It must not start
   an agent or perform prompt-readiness checks.
2. `Sandbox.startAgent()` executes the exact `AgentCommand` returned by the
   selected `AgentProvider`.
3. `batch` is the default execution mode for `afk loop`; output parsing and
   completion are owned by `StreamingAgentExecution`.
4. Tmux is retained only for explicitly interactive HITL sessions and attach.
   It is not an automation readiness or completion protocol.
5. Automation completion uses the typed `ExecutionResult` returned by the
   execution. `.afk-signal.json` and Claude statusline files are not gating
   inputs for automatic execution.
6. QA uses the same sandbox/agent-execution path as implementation. It must not
   create a second tmux-specific protocol.
7. A failed process, missing structured result, timeout, or unsupported
   provider/mode combination returns a typed failed result. The existing
   workflow/loop terminal rule then routes the backlog to `blocked / hitl`.

## Components

`AgentProvider` owns command construction and parsing. `Sandbox` owns process
placement, interruption, output capture, and cleanup. `WorkflowRunner` owns
step orchestration and maps `ExecutionResult` to template step results.
`QARunner` consumes the same execution service rather than talking to tmux.

## Execution Modes

`batch` starts one provider command with a stdin prompt and requires structured
output. Providers without `streaming` and `structured-output` capabilities are
rejected before launch. `interactive` remains a local HITL capability: it may
create a tmux session, but must report an explicit launch failure and must not
be selected by `afk loop`.

## Non-goals

This does not change backlog state semantics, GitHub/GitLab adapter details,
claim locking, branch naming, or change-request merge rules. It does not add a
database or middleware.

## Verification

Tests prove that batch execution runs the provider argv, passes its prompt to
stdin, parses a typed completion, handles non-zero exit and missing result, and
that loop and QA request batch execution. A regression test proves automatic
execution never invokes `TmuxClient.waitForPrompt`.
