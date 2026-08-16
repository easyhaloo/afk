# Codex Multi-Runtime Design

**Date:** 2026-08-16

**Status:** Design approved for implementation planning

## Goal

Allow AFK to run Codex through the host CLI and Codex app-server while preserving Claude Code as the default provider, reusing host authentication without copying secrets, and keeping Loop, QA, Tasks, and diagnostics transport-neutral.

## Scope

The implementation covers four execution choices:

1. `codex exec --json` with the host's normal Codex configuration.
2. The same CLI path with ChatGPT session authentication or an OpenAI API key.
3. The same CLI path with a configured custom Codex model provider/profile.
4. A Codex app-server transport using a spawned stdio server or a configured Unix/WebSocket endpoint.

Claude Code remains the default AFK agent. Existing `--agent codex` continues to select Codex, and new runtime/auth/provider options are optional overrides.

The implementation must not copy, print, persist, or transform Codex credentials. AFK delegates authentication to the host Codex installation and records only redacted provider/runtime diagnostics.

## Non-goals

- Attaching to the private stdio app-server already owned by the Codex desktop UI.
- Translating app-server JSON-RPC through an external JSONL wrapper process.
- Adding compatibility aliases for removed provider names.
- Making BacklogProvider, LoopRunner, or QARunner aware of Codex protocol details.

## Architecture

### Provider boundary

`AgentProvider` becomes a semantic provider boundary. It creates an execution object instead of forcing every provider to expose a child-process command:

```ts
interface AgentProvider {
  readonly name: AgentProviderName;
  readonly capabilities: ReadonlySet<AgentCapability>;

  createExecution(options: AgentExecutionOptions): Promise<AgentExecution>;
}

interface AgentExecution {
  readonly metadata: AgentExecutionMetadata;

  run(prompt: string): AsyncIterable<AgentEvent>;
  cancel(reason?: string): Promise<void>;
}
```

The execution service consumes `AgentEvent` values and owns timeout, cancellation, usage accounting, completion detection, and diagnostics. It does not know whether events came from a process or JSON-RPC connection.

Existing command-based providers use the process execution implementation. Codex supplies either `CodexExecExecution` or `CodexAppServerExecution` through the same provider boundary. No compatibility branch is retained in callers.

### Codex runtime resolution

`CodexRuntimeResolver` resolves one immutable runtime selection before a backlog is claimed:

```ts
type CodexTransport = 'auto' | 'exec' | 'app-server';
type CodexAuth = 'auto' | 'chatgpt' | 'api';

interface CodexRuntimeSelection {
  transport: Exclude<CodexTransport, 'auto'>;
  auth: Exclude<CodexAuth, 'auto'> | 'unknown';
  provider: string;
  profile?: string;
  endpoint?: string;
}
```

Resolution precedence is:

```text
CLI override > AFK config > host Codex config > auto policy
```

The `auto` policy is deterministic:

- Select `app-server` only when an explicit endpoint is configured.
- Otherwise select `exec`.
- Let Codex resolve the active login and model provider.
- Use `codex doctor --json` as a redacted readiness/diagnostic probe; do not treat the presence of a cached key as proof that the upstream accepts it.

The resolver never reads raw tokens. It may report `chatgpt`, `api`, or `unknown` based on redacted Codex diagnostics.

### Configuration

Extend the AFK workflow configuration with a Codex section while retaining `agentDefault: claude-code`:

```yaml
agentDefault: claude-code

agents:
  codex:
    transport: auto
    auth: auto
    provider: auto
    profile: null
    appServer:
      endpoint: null
      authTokenEnv: null
      startupTimeout: 10s
```

CLI overrides are available on `run`, `loop`, and `qa`:

```text
--agent <name>
--agent-transport auto|exec|app-server
--agent-auth auto|chatgpt|api
--agent-provider <name>
--agent-profile <name>
--agent-app-server <endpoint>
--agent-app-server-auth-env <environment-variable>
```

The normal command remains concise:

```bash
afk loop --agent codex
```

An explicit selection is available for tests and troubleshooting:

```bash
afk loop --agent codex --agent-transport app-server --agent-auth chatgpt
```

### Codex CLI execution

The CLI execution uses the existing Codex JSONL contract:

```text
codex exec --json --dangerously-bypass-approvals-and-sandbox -C <worktree>
```

AFK sends its prompt through stdin or the documented prompt channel. The host Codex process loads its own `config.toml`, profile, login cache, environment, and provider implementation.

Codex JSONL events map as follows:

```text
item.completed(agent_message) -> result
turn.completed(usage)        -> usage
error / turn.failed          -> error
all other valid events       -> text/diagnostic event
```

### Codex app-server execution

`CodexAppServerExecution` speaks JSON-RPC directly. It performs this lifecycle:

```text
start transport
  -> initialize
  -> initialized notification
  -> thread/start
  -> turn/start
  -> consume streamed notifications
  -> detect turn/completed or turn/failed
  -> cancel/close on timeout or shutdown
```

Supported endpoints:

- `stdio://`: AFK spawns `codex app-server --listen stdio://`.
- `unix://...`: AFK connects to a local Unix socket.
- `ws://` / `wss://`: AFK connects to an explicitly configured endpoint and sends the configured bearer token without logging it.

The desktop app's private stdio app-server is not attachable by AFK. To reuse desktop authentication, AFK may spawn its own app-server using the same host Codex login cache, or connect to a user-provided endpoint exposed by the desktop environment.

App-server events normalize to the existing `AgentEvent` union. The execution metadata records only transport, provider, endpoint kind, and app-server thread ID.

### Loop and QA propagation

`LoopRunner` resolves one `AgentProvider` and one `CodexRuntimeSelection` per loop invocation. It passes that selection to both implementation and QA. `QARunner` never resolves a different provider and never knows the selected transport.

The Tasks projection receives:

- provider name (`codex`);
- transport (`exec` or `app-server`);
- redacted auth/provider diagnostics;
- app-server thread ID when applicable;
- current sandbox and execution phase.

### Readiness and failure semantics

Readiness is checked before backlog claim:

```text
invalid authentication/provider/endpoint
  -> loop reports infrastructure failure
  -> no backlog is claimed or relabeled
  -> ready backlog remains ready
```

Task-level failures after claim use the existing state machine:

```text
implementation failure -> stage::blocked + mode::hitl
QA failure             -> stage::blocked + mode::hitl
timeout                -> stage::blocked + mode::hitl
transport disconnect   -> stage::blocked + mode::hitl
```

Execution diagnostics are stored in the local filesystem runtime store and summarized in the provider comment without credentials. A successful implementation still flows into verification and QA using the same resolved Codex runtime.

## Testing strategy

### Unit and contract tests

- Runtime resolver precedence: CLI, AFK config, host config, auto.
- Provider/auth selection without exposing credentials.
- Process execution event normalization for Codex JSONL.
- App-server JSON-RPC handshake, thread/turn lifecycle, usage, completion, cancellation, timeout, and failure.
- Unsupported or malformed events produce diagnostics rather than crashes.

### Workflow tests

- Loop implementation and QA receive the same provider and runtime selection.
- Readiness failure occurs before claim and leaves the backlog unchanged.
- Task-level runtime failures route to `blocked + hitl`.
- Tasks projection includes transport-neutral execution metadata.
- `goal_complete` is detected from both CLI result messages and app-server agent messages.

### Real integration tests

Provide a separate opt-in command so normal tests do not depend on host credentials:

```bash
npm run test:e2e:codex -- --transport exec
npm run test:e2e:codex -- --transport app-server
```

When enabled, the command must fail loudly on invalid host authentication rather than silently skip. It must verify implementation, QA, `goal_complete`, task diagnostics, and the final merge-ready/human-approval state.

## Migration

1. Introduce the execution interface and adapt all existing providers.
2. Move process launching and line parsing behind the process execution implementation.
3. Add Codex runtime configuration and resolver.
4. Implement Codex app-server execution and contract fixtures.
5. Wire CLI, Loop, QA, Tasks, and readiness diagnostics.
6. Run the opt-in real E2E matrix with valid host credentials.

No production caller should inspect Codex command arguments or JSON event shapes after migration.
