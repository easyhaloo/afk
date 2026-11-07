# ADR-0032: A provider and the runtime that runs it are one decision

- Status: accepted
- Date: 2026-11-06

## Context

A Codex agent kept failing with

```
AGENT_TURN_FAILED: unexpected status 402 Payment Required:
上游流式请求失败，HTTP 402, url: http://127.0.0.1:8788/responses
```

`8788` is the host's local model proxy. The request never reached the
model AFK was configured to use: it went to the host's *default* Codex
provider instead.

AFK was configured correctly. `agents.codex.profile` named a profile, and
that profile was verified by hand — running the same argv in the same
terminal produced `minimax/minimax-m3` in the status line and a successful
turn. But the argv AFK actually spawned did not contain `--profile`:

```
tmux new-session -d -s <run>-implement -n main -c <worktree> \
  'codex' '--dangerously-bypass-approvals-and-sandbox' '--no-alt-screen' \
  '--config' 'check_for_update_on_startup=false' '-C' '<worktree>'
```

AFK reported no error. The agent started, connected, and failed on the
first turn — with a transport error from an endpoint nobody had asked for.

### Why the profile was dropped

AFK carried the provider and the runtime in two independent channels:

- `agentProvider` — *which* agent runs. A workflow step may override it
  (`step.provider` in `workflow-engine.ts`).
- `agentRuntime` — *how* it runs: the Codex `provider`, `profile`,
  `transport` and `endpoint`.

The runtime was resolved once, alongside the **request-level** provider:

```ts
// run-request.ts
const agentProvider = resolveAgentProviderName(input.agentProvider ?? config.agentDefault);
...
agentRuntime: agentProvider === 'codex'
  ? (input.agentRuntime?.kind === 'codex' ? input.agentRuntime : resolveDefaultCodexRuntime(config))
  : { kind: 'default' },
```

The step then chose its provider independently, and inherited the runtime
as-is:

```ts
// workflow-engine.ts
agentProvider: step.provider ? createAgentProvider(step.provider) : this.agentProvider,
runtime: this.agentRuntime,
```

With `agentDefault: claude-code` and a workflow template whose implement
step runs `provider: codex`, the request carried `{kind:'default'}` — no
Codex settings at all — and the Codex step received it unchanged. The
provider was Codex; the runtime was not.

The failure is silent by construction. `{kind:'default'}` is a valid
runtime, so nothing rejects it. Codex does not object to being run without
a `--profile`; it reads its own host configuration and uses whatever the
host defaults to. The mismatch only becomes visible as an error from that
other endpoint.

Two consequences made it hard to see:

- The request-level runtime was the only one AFK ever probed, so the Codex
  readiness check never ran for a Codex step. Nothing failed fast; the
  agent simply started against the wrong endpoint.
- `diagnostics/<runId>/runtime.json` reported the **request-level**
  provider, so the run record said `claude-code` while the process on
  screen was a Codex TUI.

## Decision

**A provider and the runtime that runs it are resolved together, and a
step's provider decides which runtime it gets.**

1. `resolveRuntimeForProvider(provider, runtime, codexConfig)` returns the
   runtime that belongs to `provider`:
   - a Codex runtime is reused only for Codex;
   - a non-Codex provider resolves to no runtime, which is the value AFK
     used before provider-specific runtimes existed;
   - when the step runs Codex and the request carried no Codex runtime,
     the Codex runtime is resolved from AFK's configuration, so the step
     keeps the `provider`, `profile` and `transport` the operator set.

2. The workflow engine binds the runtime **per step**, at the point where
   the step's provider is already known, instead of once per request.

3. A runtime resolved inside the run is probed before the agent starts, so
   an unreachable model fails before the first turn instead of during it.
   The probe is per provider and per run: a live readiness check costs a
   real model round-trip, so a provider is never probed twice.

## Consequences

- A step that overrides the provider no longer inherits the previous
  provider's runtime. Its own settings apply, which is what an operator
  configuring `agents.codex.*` expects.
- The step-level runtime is probed, so a misconfigured provider fails at
  the start of its step with the probe's diagnosis rather than as a
  transport error from an unrelated endpoint.
- Only Codex carries provider-specific runtime settings today. Other
  providers resolve to no runtime, exactly as before, so this changes
  nothing for them.
- The run record's `agentProvider` field still reports the request-level
  provider. It is a run-level fact and is not changed by this decision;
  the per-step provider remains visible in the workflow template.
