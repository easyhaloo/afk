# Codex Multi-Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support Codex CLI authentication/provider variants and direct Codex app-server execution through one transport-neutral AFK agent lifecycle, with readiness checks before backlog claim and real opt-in E2E coverage.

**Architecture:** `AgentProvider.createExecution()` becomes the only workflow-facing execution entry point. Command providers share a process-provider base that delegates to the selected sandbox; Codex overrides creation only when its immutable runtime selection chooses app-server. A typed runtime resolver handles CLI/config/host precedence, while a direct JSON-RPC client handles app-server stdio, Unix, and WebSocket transports without wrappers.

**Tech Stack:** TypeScript, Commander, Vitest, Node child processes, Node sockets, `ws`, Codex JSONL, Codex app-server JSON-RPC, existing Sandbox/TaskRuntime/BacklogProvider modules.

---

## Dependency order

1. Task 1 is the serial foundation.
2. Tasks 2 and 3 may run in parallel after Task 1.
3. Task 4 starts after Tasks 2 and 3 are integrated.
4. Tasks 5 and 6 complete documentation, real E2E, and final verification.

## File map

- Create `src/lib/agents/process-provider.ts`: shared process-backed implementation of `AgentProvider.createExecution()`.
- Modify `src/lib/agents/types.ts`: execution options, runtime metadata, and provider execution contract.
- Modify all concrete agent providers: use the new provider contract without compatibility branches.
- Modify `src/lib/workflows/execution-service.ts`, `src/lib/workflows.ts`, `src/lib/modules/qa-runner.ts`, and `src/lib/workflows/resume.ts`: call only `createExecution()`.
- Create `src/lib/agents/codex-runtime.ts`: Codex config types, precedence, readiness probe, and redaction.
- Modify `src/lib/core/config/manager.ts`: structured `.afk/config.yml` plus environment defaults for Codex.
- Create `src/lib/agents/codex-app-server/transport.ts`: stdio, Unix WebSocket, and WebSocket transports.
- Create `src/lib/agents/codex-app-server/client.ts`: request correlation and JSON-RPC lifecycle.
- Create `src/lib/agents/codex-app-server/execution.ts`: app-server implementation of the running execution lifecycle.
- Modify CLI/workflow request modules: propagate one immutable runtime selection.
- Modify `src/lib/runtime/task-runtime.ts` and run-state diagnostics: persist transport-neutral metadata.
- Create `tests/e2e/codex-runtime.ts`: opt-in real host E2E entry point.

### Task 1: Replace command-oriented workflow coupling with provider-owned execution

**Files:**
- Create: `src/lib/agents/process-provider.ts`
- Modify: `src/lib/agents/types.ts`
- Modify: `src/lib/agents/claude-code.ts`
- Modify: `src/lib/agents/codex.ts`
- Modify: `src/lib/agents/cursor.ts`
- Modify: `src/lib/agents/pi.ts`
- Modify: `src/lib/agents/opencode.ts`
- Modify: `src/lib/agents/copilot.ts`
- Modify: `src/lib/workflows/execution-service.ts`
- Modify: `src/lib/workflows.ts`
- Modify: `src/lib/modules/qa-runner.ts`
- Modify: `src/lib/workflows/resume.ts`
- Modify: `src/lib/sandbox/types.ts`
- Modify: `src/lib/sandbox/providers/local.ts`
- Modify: `src/lib/sandbox/providers/streaming.ts`
- Modify: `src/lib/sandbox/container/sandbox.ts`
- Test: `src/lib/workflows/execution-service.test.ts`
- Test: `src/lib/agents/providers.test.ts`
- Test: `src/lib/modules/qa-runner.test.ts`

- [x] **Step 1: Write failing execution-boundary tests**

Update the fake provider in `execution-service.test.ts` so it exposes only `createExecution`, and assert that the service delegates the complete request:

```ts
const createExecution = vi.fn(async () => execution(completed));
const provider: AgentProvider = {
  name: 'claude-code',
  capabilities: new Set(),
  createExecution,
};

await service.execute(request({ provider }));

expect(createExecution).toHaveBeenCalledWith(expect.objectContaining({
  sandbox,
  prompt: 'implement the backlog',
  worktreePath: '/tmp/worktree',
  executionMode: 'batch',
  signalType: 'goal_complete',
}));
```

Add QA and Workflow assertions that their providers may omit `buildCommand`; this proves callers no longer construct commands.

- [x] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx vitest run src/lib/workflows/execution-service.test.ts src/lib/modules/qa-runner.test.ts src/lib/agents/providers.test.ts --reporter=dot
```

Expected: TypeScript/test failures report missing `createExecution` and current direct `buildCommand` usage.

- [x] **Step 3: Define the provider-owned execution contract**

Add to `src/lib/agents/types.ts`:

```ts
import type { AgentExecution, Sandbox } from '../sandbox/types';

export interface AgentExecutionMetadata {
  provider: AgentProviderName;
  transport: 'process' | 'exec' | 'app-server';
  auth?: 'chatgpt' | 'api' | 'unknown';
  modelProvider?: string;
  endpointKind?: 'stdio' | 'unix' | 'ws' | 'wss';
  threadId?: string;
}

export interface CodexRuntimeSelection {
  kind: 'codex';
  transport: 'exec' | 'app-server';
  auth: 'chatgpt' | 'api' | 'unknown';
  provider: string;
  profile?: string;
  endpoint?: string;
  authTokenEnv?: string;
  startupTimeoutMs: number;
}

export type AgentRuntimeSelection =
  | { kind: 'default' }
  | CodexRuntimeSelection;

export interface AgentExecutionOptions extends AgentCommandOptions {
  sandbox: Sandbox;
  prompt: string;
  signalType: 'goal_complete';
  generation: number;
  runtime?: AgentRuntimeSelection;
}

export interface AgentProvider {
  readonly name: AgentProviderName;
  readonly capabilities: ReadonlySet<AgentCapability>;
  createExecution(options: AgentExecutionOptions): Promise<AgentExecution>;
}
```

Keep existing optional usage/resume methods.

Add required `metadata: AgentExecutionMetadata` to the running `AgentExecution` interface in `sandbox/types.ts`, pass metadata through `AgentStartOptions`, and expose it from local, streaming, and container executions. This gives process and app-server executions one diagnostics surface without optional compatibility behavior.

- [x] **Step 4: Implement the process provider base**

Create `src/lib/agents/process-provider.ts`:

```ts
export abstract class ProcessAgentProvider implements AgentProvider {
  abstract readonly name: AgentProviderName;
  abstract readonly capabilities: ReadonlySet<AgentCapability>;
  abstract buildCommand(options: AgentCommandOptions): AgentCommand;
  parseLine?(line: string): AgentEvent[];

  protected executionMetadata(_options: AgentExecutionOptions): AgentExecutionMetadata {
    return { provider: this.name, transport: 'process' };
  }

  async createExecution(options: AgentExecutionOptions): Promise<AgentExecution> {
    return options.sandbox.startAgent({
      command: this.buildCommand(options),
      metadata: this.executionMetadata(options),
      generation: options.generation,
      prompt: options.prompt,
      signalType: options.signalType,
      executionMode: options.executionMode,
      parseLine: this.parseLine?.bind(this),
    });
  }
}
```

Make every current CLI provider extend `ProcessAgentProvider`. Keep each concrete `buildCommand()` and `parseLine()` unchanged so provider contract tests remain meaningful. Codex overrides `executionMetadata()` to report `exec`, resolved auth, and resolved model provider.

Replace `AgentStartOptions.agentProvider` with a provider-neutral `parseLine?: (line: string) => AgentEvent[]`. Streaming execution consumes that callback, so Sandbox no longer depends on the complete provider object.

- [x] **Step 5: Remove direct command construction from workflow callers**

Replace each `buildCommand() + sandbox.startAgent()` sequence in `AgentExecutionService`, `WorkflowRunner.runPhase`, `QARunner.process`, and resume flow with:

```ts
const execution = await agentProvider.createExecution({
  sandbox,
  worktreePath,
  sessionId,
  prompt,
  signalType: 'goal_complete',
  generation,
  interactive: executionMode !== 'batch',
  executionMode,
  runtime,
});
```

Do not retain a caller fallback to `buildCommand`.

- [x] **Step 6: Run focused and compile verification**

```bash
npx vitest run src/lib/workflows/execution-service.test.ts src/lib/modules/qa-runner.test.ts src/lib/agents/providers.test.ts --reporter=dot
npm run typecheck
```

Expected: all selected tests and typecheck pass.

- [x] **Step 7: Commit the execution boundary**

```bash
git add src/lib/agents src/lib/sandbox src/lib/workflows/execution-service.ts src/lib/workflows.ts src/lib/modules/qa-runner.ts src/lib/workflows/resume.ts
git commit -m "refactor(agent): own execution behind provider boundary"
```

### Task 2: Add Codex runtime configuration, resolution, and readiness

**Files:**
- Create: `src/lib/agents/codex-runtime.ts`
- Test: `src/lib/agents/codex-runtime.test.ts`
- Modify: `src/lib/core/config/manager.ts`
- Modify: `tests/config.test.ts`
- Modify: `src/lib/workflows/run-request.ts`
- Test: `src/lib/workflows/run-request.test.ts`

- [x] **Step 1: Write failing config and precedence tests**

Cover:

```ts
expect(resolveCodexRuntime({ cli: {}, config: {} })).toMatchObject({
  kind: 'codex', transport: 'exec', auth: 'unknown', provider: 'auto',
});

expect(resolveCodexRuntime({
  cli: { transport: 'app-server' },
  config: { transport: 'exec', appServer: { endpoint: 'stdio://' } },
})).toMatchObject({ transport: 'app-server' });

expect(resolveCodexRuntime({
  cli: {},
  config: { transport: 'auto', appServer: { endpoint: 'unix:///tmp/codex.sock' } },
})).toMatchObject({ transport: 'app-server', endpoint: 'unix:///tmp/codex.sock' });
```

Add a config fixture proving `.afk/config.yml` is parsed structurally and environment values fill only missing fields.

- [x] **Step 2: Run tests and verify RED**

```bash
npx vitest run src/lib/agents/codex-runtime.test.ts tests/config.test.ts src/lib/workflows/run-request.test.ts --reporter=dot
```

Expected: missing resolver/types and missing structured Codex config.

- [x] **Step 3: Implement typed runtime configuration**

```ts
export type CodexTransport = 'auto' | 'exec' | 'app-server';
export type CodexAuth = 'auto' | 'chatgpt' | 'api';

export interface CodexConfig {
  transport: CodexTransport;
  auth: CodexAuth;
  provider: string;
  profile?: string;
  appServer: {
    endpoint?: string;
    authTokenEnv?: string;
    startupTimeoutMs: number;
  };
}

```

Use the `CodexRuntimeSelection` already defined by Task 1; this task owns only configuration parsing, resolution, and readiness.

- [x] **Step 4: Replace ad hoc workflow config parsing with structured parsing**

Use `js-yaml` for `.afk/config.yml`. Keep existing environment names and add:

```text
AFK_CODEX_TRANSPORT
AFK_CODEX_AUTH
AFK_CODEX_PROVIDER
AFK_CODEX_PROFILE
AFK_CODEX_APP_SERVER
AFK_CODEX_APP_SERVER_AUTH_ENV
AFK_CODEX_APP_SERVER_STARTUP_TIMEOUT
```

Validate enum values and endpoint schemes. Invalid configuration must fail before provider bundle creation.

- [x] **Step 5: Implement redacted host readiness probing**

Run `codex doctor --json` with `execFile`, parse only redacted fields, and return:

```ts
export type CodexReadiness =
  | { ready: true; auth: 'chatgpt' | 'api' | 'unknown'; provider: string }
  | { ready: false; code: 'CLI_NOT_FOUND' | 'AUTH_INVALID' | 'PROVIDER_INVALID' | 'ENDPOINT_UNREACHABLE'; message: string };
```

Never include environment values, token fragments, or `auth.json` contents. Inject the command runner in tests.

- [x] **Step 6: Propagate immutable runtime selection in run requests**

Add `agentRuntime?: AgentRuntimeSelection` to `WorkflowRunCliInput` and `WorkflowRunRequest`. Resolve it once when `agentProvider === 'codex'`; use `{ kind: 'default' }` for other providers.

- [x] **Step 7: Run focused tests and commit**

```bash
npx vitest run src/lib/agents/codex-runtime.test.ts tests/config.test.ts src/lib/workflows/run-request.test.ts --reporter=dot
npm run typecheck
git add src/lib/agents/codex-runtime.ts src/lib/agents/codex-runtime.test.ts src/lib/core/config/manager.ts tests/config.test.ts src/lib/workflows/run-request.ts src/lib/workflows/run-request.test.ts
git commit -m "feat(agent): resolve codex runtime configuration"
```

### Task 3: Implement direct Codex app-server JSON-RPC execution

**Files:**
- Create: `src/lib/agents/codex-app-server/transport.ts`
- Create: `src/lib/agents/codex-app-server/client.ts`
- Create: `src/lib/agents/codex-app-server/events.ts`
- Create: `src/lib/agents/codex-app-server/execution.ts`
- Test: `src/lib/agents/codex-app-server/client.test.ts`
- Test: `src/lib/agents/codex-app-server/execution.test.ts`
- Modify: `src/lib/agents/codex.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [x] **Step 1: Add WebSocket support**

```bash
npm install ws
npm install --save-dev @types/ws
```

Use Node streams and `net` for stdio/Unix plumbing; do not add a JSON-RPC framework.

- [x] **Step 2: Write failing transport/client contract tests**

Use in-memory newline streams to assert request IDs and handshake order:

```ts
expect(sent.map(message => message.method)).toEqual([
  'initialize',
  'initialized',
  'thread/start',
  'turn/start',
]);
```

Assert out-of-order responses are correlated by `id`, server errors reject the matching request, and close rejects pending requests.

- [x] **Step 3: Implement JSON-RPC transports**

```ts
interface AppServerTransport {
  send(message: JsonRpcMessage): Promise<void>;
  messages(): AsyncIterable<JsonRpcMessage>;
  close(): Promise<void>;
}
```

Implement stdio by spawning `codex app-server --listen stdio://`; Unix as WebSocket over `net.createConnection(socketPath)`; and `ws`/`wss` with a bearer token read only from the configured environment variable. Never log headers or environment values.

- [x] **Step 4: Implement the typed app-server client**

```ts
await client.request('initialize', {
  clientInfo: { name: 'afk', title: 'AFK', version: packageVersion },
});
await client.notify('initialized');
const started = await client.request('thread/start', {
  cwd: worktreePath,
  approvalPolicy: 'never',
  sandbox: 'danger-full-access',
  modelProvider,
});
await client.request('turn/start', {
  threadId: started.thread.id,
  input: [{ type: 'text', text: prompt, text_elements: [] }],
});
```

Cancellation sends `turn/interrupt` with active thread and turn IDs.

- [x] **Step 5: Normalize app-server notifications**

Map:

```text
item/completed + agentMessage text -> result
thread/tokenUsage/updated          -> usage
turn/completed                     -> terminal completion
error with willRetry=false         -> error
turn status failed                 -> error
```

Export and reuse `extractGoalComplete()` from `execution-protocol.ts`; do not duplicate StreamingAgentExecution marker parsing.

- [x] **Step 6: Implement the running execution lifecycle**

`CodexAppServerExecution` implements `waitForEvent`, `waitForResult`, `interrupt`, `kill`, `captureOutput`, `captureSession`, and `resume`. Resume remains unsupported through the existing capability gate. Result metadata includes app-server thread ID and the same structured completion payload as CLI streaming.

- [x] **Step 7: Select app-server from CodexProvider**

```ts
if (options.runtime?.kind === 'codex' && options.runtime.transport === 'app-server') {
  return CodexAppServerExecution.start(options, options.runtime);
}
return super.createExecution(options);
```

Reject spawned stdio app-server with Docker/Podman before starting; configured remote endpoints own their isolation.

- [x] **Step 8: Run focused tests and commit**

```bash
npx vitest run src/lib/agents/codex-app-server/client.test.ts src/lib/agents/codex-app-server/execution.test.ts src/lib/agents/providers.test.ts --reporter=dot
npm run typecheck
git add package.json package-lock.json src/lib/agents/codex.ts src/lib/agents/codex-app-server
git commit -m "feat(agent): execute codex through app server"
```

### Task 4: Integrate runtime selection with CLI, Loop, QA, and Tasks

**Files:**
- Modify: `src/commands/run.ts`
- Modify: `src/commands/loop.ts`
- Modify: `src/commands/qa.ts`
- Modify: `src/commands/loop.test.ts`
- Modify: `src/commands/backlog.test.ts`
- Modify: `src/lib/workflows/run-cmd.ts`
- Modify: `src/lib/modules/loop-runner.ts`
- Modify: `src/lib/modules/loop-runner.test.ts`
- Modify: `src/lib/modules/qa-runner.ts`
- Modify: `src/lib/modules/qa-runner.test.ts`
- Modify: `src/lib/runtime/task-runtime.ts`
- Modify: `src/lib/runtime/task-runtime.test.ts`
- Modify: `src/lib/sessions/run-state.ts`

- [x] **Step 1: Write failing CLI and propagation tests**

Assert `run`, `loop`, and `qa` expose the same six runtime overrides and preserve string values. Add a Loop test proving implementation and QA receive the same `CodexRuntimeSelection` object.

- [x] **Step 2: Write readiness-before-claim test**

Inject a failing readiness probe, start one loop iteration, and assert:

```ts
expect(backlog.claim).not.toHaveBeenCalled();
expect(backlog.transition).not.toHaveBeenCalled();
expect(loop.status().infrastructureError).toMatch(/authentication/i);
```

- [x] **Step 3: Add shared Commander options**

Create one `addAgentRuntimeOptions(command)` helper used by all three commands. Validate enum values at the CLI boundary and pass a normalized override object into runtime resolution.

- [x] **Step 4: Propagate one runtime selection through Loop and QA**

Resolve readiness before `LoopRunner.start()` polls. Store the selection in internal options and pass it unchanged to `WorkflowRunner.run()` and QARunner dependencies. Do not re-read host config between implementation and QA.

- [x] **Step 5: Extend local runtime diagnostics**

Add optional fields to `TaskRuntimeRecord` and `RunRequest`:

```ts
agentTransport?: 'process' | 'exec' | 'app-server';
agentAuth?: 'chatgpt' | 'api' | 'unknown';
agentModelProvider?: string;
agentThreadId?: string;
```

Persist only redacted values. Update Tasks projection tests without increasing backlog data responsibilities.

- [x] **Step 6: Run integration-focused tests and commit**

```bash
npx vitest run src/commands/loop.test.ts src/commands/backlog.test.ts src/lib/modules/loop-runner.test.ts src/lib/modules/qa-runner.test.ts src/lib/runtime/task-runtime.test.ts --reporter=dot
npm run typecheck
git add src/commands src/lib/workflows/run-cmd.ts src/lib/modules src/lib/runtime/task-runtime.ts src/lib/runtime/task-runtime.test.ts src/lib/sessions/run-state.ts
git commit -m "feat(agent): propagate codex runtime through workflow"
```

### Task 5: Add deterministic app-server integration fixtures and real E2E command

**Files:**
- Create: `tests/fixtures/fake-codex-app-server.mjs`
- Create: `tests/e2e/codex-runtime.ts`
- Create: `tests/e2e/codex-runtime.test.ts`
- Modify: `package.json`
- Modify: `.gitignore`

- [x] **Step 1: Build a protocol fixture**

The fixture reads JSON-RPC JSONL from stdin and emits initialize, thread/start, turn/start, `item/completed`, usage, and `turn/completed` responses. Its agent message ends with:

```text
<goal_complete>{"type":"goal_complete","kind":"task","summary":"app server fixture complete"}</goal_complete>
```

- [x] **Step 2: Add deterministic integration coverage**

Run real `CodexAppServerExecution` against the fixture and assert completed result, thread ID, usage, diagnostics, cancellation, and process cleanup.

- [x] **Step 3: Add the opt-in real host runner**

Add:

```json
"test:e2e:codex": "tsx tests/e2e/codex-runtime.ts"
```

Support `--transport exec|app-server`. The script must run readiness and fail redacted when invalid; create a bounded backlog only after readiness; run Loop implementation and QA; assert `goal_complete`, Tasks metadata, and root `merge_ready + hitl`; and print backlog/MR URLs. It must never silently skip when explicitly invoked.

- [x] **Step 4: Run fixture integration and commit**

```bash
npx vitest run tests/e2e/codex-runtime.test.ts --reporter=dot
git diff --check
git add package.json .gitignore tests/fixtures/fake-codex-app-server.mjs tests/e2e/codex-runtime.ts tests/e2e/codex-runtime.test.ts
git commit -m "test(agent): cover codex runtime transports"
```

### Task 6: Document, verify, and run the real matrix

**Files:**
- Modify: `docs/WORKFLOWS.md`
- Modify: `docs/WORKFLOWS_zh.md`
- Modify: `docs/superpowers/plans/2026-08-16-codex-multi-runtime.md`

- [x] **Step 1: Document supported runtime combinations**

Document automatic selection, explicit overrides, ChatGPT/API/custom provider requirements, app-server endpoints, local-only restriction for spawned app-server, redacted readiness failures, and recovery.

- [x] **Step 2: Run full automated verification**

```bash
npm run typecheck
npm run build
npm test -- --reporter=dot
git diff --check
```

Expected: zero failures and only intentional platform skips already present in the baseline.

Verification evidence (2026-08-16): build, typecheck, and `git diff --check`
exited 0; Vitest reported 79 passed files, 1 skipped file, 561 passed tests,
and 3 existing platform skips.

- [ ] **Step 3: Run real exec E2E**

```bash
PATH="/Applications/ChatGPT.app/Contents/Resources:$PATH" npm run test:e2e:codex -- --transport exec
```

Expected: implementation and QA complete with Codex, and a root MR waits for human approval. If readiness fails, stop without creating or claiming a backlog.

Current host evidence (2026-08-16): exited 1 with redacted `AUTH_INVALID` before
tracker creation; GitHub contained no `[Codex E2E]` backlog after the run.

- [ ] **Step 4: Run real app-server E2E**

```bash
PATH="/Applications/ChatGPT.app/Contents/Resources:$PATH" npm run test:e2e:codex -- --transport app-server
```

Expected: the same lifecycle passes through a spawned app-server and records its thread ID.

Current host evidence (2026-08-16): exited 1 at the shared `AUTH_INVALID`
readiness gate before app-server startup or tracker creation.

- [x] **Step 5: Commit documentation and final evidence**

```bash
git add docs/WORKFLOWS.md docs/WORKFLOWS_zh.md docs/superpowers/plans/2026-08-16-codex-multi-runtime.md
git commit -m "docs(agent): document codex runtime selection"
git status --short --branch
git log --oneline --decorate -8
```
