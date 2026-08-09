# Codex Provider End-to-End Design

## Goal

Validate Codex as a real AFK agent runtime across implementation and QA without
changing AFK's default agent. `claude-code` remains the default; Codex is
selected explicitly for a run with `--agent codex`.

Success means a provider-backed backlog can be claimed, implemented by Codex,
verified by Codex in the QA worktree, and published according to the existing
merge policy. The Tasks projection and execution diagnostics must identify
`codex` throughout the run.

## Non-goals

- Do not change the default provider from `claude-code`.
- Do not add a shell wrapper or hard-code a Codex Desktop application path.
- Do not add a second completion protocol; Codex uses the existing
  `<goal_complete>` payload contract.
- Do not weaken AFK's sandbox abstraction or add a database/service dependency.
- Do not remove the other registered agent providers.

## Provider selection

The explicit provider selection must flow through the complete pipeline:

```text
afk run/loop/qa --agent codex
              |
              v
       WorkflowRunner (implementation)
              |
              v
          QARunner (verification)
```

`afk run` already accepts `--agent`; `afk loop` and `afk qa` will expose the
same option. Loop resolves one provider name for a backlog chain and passes it
to both implementation and QA. QARunner resolves its provider from the
explicit dependency first and the workflow configuration second; its fallback
remains `claude-code`.

The environment variable `AFK_AGENT_DEFAULT=codex` remains supported by the
existing workflow configuration, but is not required for the test and does not
replace the explicit CLI option.

## Codex command contract

The provider launches the `codex` executable directly from `PATH`.

Batch execution uses:

```text
codex exec --json --dangerously-bypass-approvals-and-sandbox -C <worktree>
```

AFK writes the execution prompt to stdin and reads JSONL from stdout. The
approval/sandbox bypass is deliberate because AFK owns the outer sandbox and
the backlog run must not stall on an inner permission prompt.

Interactive execution uses:

```text
codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen -C <worktree>
```

The existing tmux transport sends the prompt after the TUI is ready. The prompt
instructs Codex to write `.afk-signal.json` on completion, so interactive mode
keeps the same filesystem signal lifecycle as the other providers.

No executable discovery logic is added to production. A missing or broken
`codex` on `PATH` must produce an actionable spawn diagnostic. For the local
real E2E run, the ChatGPT Desktop resource directory may be prepended to
`PATH`; this is test environment setup, not an AFK runtime wrapper.

## JSONL event mapping

Codex JSONL is mapped into the provider-neutral `AgentEvent` model:

| Codex event | AFK event |
| --- | --- |
| completed `agent_message` item | `result` containing the message text |
| `turn.completed.usage` | normalized `usage` token counts |
| `turn.failed` or top-level `error` | `error` with a stable message |
| other lifecycle/tool events | `text` progress event |

The streaming execution layer remains responsible for extracting
`<goal_complete>...</goal_complete>` from result text. CodexProvider does not
know AFK backlog or QA payload shapes.

Codex declares `streaming`, `structured-output`, `usage`, and `interactive`
capabilities after the JSONL behavior is covered. Resume remains excluded from
this change even though newer Codex versions expose resume commands, because
AFK does not yet have a tested Codex checkpoint contract.

## Failure handling and diagnostics

- Missing executable or spawn errors route the backlog to `blocked + hitl`
  through the existing workflow failure path.
- Codex JSONL error events preserve their message in execution diagnostics.
- Non-zero exit without a structured error preserves stderr/stdout tail.
- Missing or malformed `goal_complete` is treated as an incomplete execution,
  never as success.
- Loop uses the same provider name for QA; it must not silently fall back to
  Claude Code between phases.
- Runtime records expose `agentProvider: codex` for both implementation and QA.

## Automated verification

Tests are added before implementation and must cover:

1. Batch command construction with `exec`, `--json`, explicit bypass, and the
   worktree path.
2. Interactive command construction without `exec`, with bypass,
   `--no-alt-screen`, and the worktree path.
3. Codex JSONL agent message, usage, and error parsing.
4. `afk loop --agent codex` propagation into both WorkflowRunner and QARunner.
5. `afk qa --agent codex` provider selection.
6. Streaming completion from a controlled Codex-compatible fixture that emits
   a valid `goal_complete` result.
7. Existing Claude Code provider and default-selection regressions.

## Real end-to-end verification

After automated tests pass:

1. Confirm the selected host Codex CLI version and authentication.
2. Prepend the working Codex executable directory to `PATH` for the test
   process only.
3. Create a small provider-backed AFK backlog in the current repository.
4. Run `afk loop --agent codex --max-iterations 1` in batch mode.
5. Observe the Tasks projection while implementation and QA are active.
6. Verify both runtime records and diagnostics identify `codex`.
7. Verify implementation reaches `verification`, QA returns a typed
   `goal_complete`, and the expected merge request is created.
8. Verify a child backlog may merge into its parent automatically, while a
   root backlog merge request waits for human approval before `main`.

The test report must include the backlog URL, change/MR URL, provider identity
for both phases, final backlog state, and any environment-specific limitations.
