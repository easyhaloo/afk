# Codex Provider End-to-End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make explicitly selected Codex executions work through AFK implementation and QA, then prove the complete provider-backed loop with a real Codex CLI run while retaining Claude Code as the default.

**Architecture:** CodexProvider owns only direct CLI command construction and JSONL-to-AgentEvent translation. CLI and LoopRunner propagate one explicit provider name through WorkflowRunner and QARunner; the existing sandbox and `goal_complete` protocol continue to own process isolation and completion detection.

**Tech Stack:** TypeScript, Commander, Vitest, Node child processes, Codex CLI JSONL, existing AFK AgentProvider/Sandbox/BacklogProvider abstractions.

---

## File Map

- Modify `src/lib/agents/codex.ts`: current Codex CLI commands, capabilities, JSONL parsing.
- Modify `src/lib/agents/providers.test.ts`: command and event contract tests.
- Modify `src/commands/loop.ts`: expose and forward `--agent`.
- Modify `src/commands/qa.ts`: expose and resolve `--agent`.
- Modify `src/commands/backlog.test.ts`: canonical CLI option coverage.
- Modify `src/lib/core/config/manager.ts`: canonical `claude-code` default.
- Modify `tests/config.test.ts`: default provider regression.
- Modify `src/lib/workflows/run-request.ts`: remove the old `claude` alias branch.
- Modify `src/lib/workflows/run-request.test.ts`: provider selection and validation.
- Modify `src/lib/modules/loop-runner.ts`: carry one agent provider through implementation and QA.
- Modify `src/lib/modules/loop-runner.test.ts`: cross-phase provider propagation coverage.
- Modify `src/lib/modules/qa-runner.ts`: resolve configured provider instead of hard-coding Claude Code.
- Modify `src/lib/modules/qa-runner.test.ts`: config-based Codex selection coverage.
- Modify `src/lib/sandbox/providers/streaming.test.ts`: Codex-compatible JSONL completion fixture.
- Modify `docs/WORKFLOWS.md` and `docs/WORKFLOWS_zh.md`: explicit Codex invocation and diagnostics.

### Task 1: Implement the current Codex CLI contract

**Files:**
- Modify: `src/lib/agents/codex.ts`
- Test: `src/lib/agents/providers.test.ts`

- [x] **Step 1: Write failing command-construction tests**

Add assertions for batch and interactive modes:

```ts
it('builds JSONL batch execution with autonomous permissions', () => {
  const cmd = p.buildCommand({ ...opts(), executionMode: 'batch' });
  expect(cmd.argv).toEqual([
    'codex', 'exec', '--json', '--dangerously-bypass-approvals-and-sandbox',
    '-C', '/tmp/worktree',
  ]);
});

it('builds inline interactive execution with autonomous permissions', () => {
  const cmd = p.buildCommand({ ...opts(), executionMode: 'interactive' });
  expect(cmd.argv).toEqual([
    'codex', '--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen',
    '-C', '/tmp/worktree',
  ]);
});
```

- [x] **Step 2: Write failing Codex JSONL parsing tests**

Cover an agent result, normalized usage, an error event, and unrelated progress:

```ts
expect(p.parseLine(JSON.stringify({
  type: 'item.completed',
  item: { type: 'agent_message', text: '<goal_complete>{"type":"goal_complete","kind":"task","summary":"done"}</goal_complete>' },
}))).toEqual([{ type: 'result', result: expect.stringContaining('goal_complete') }]);

expect(p.parseLine(JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: 4 },
}))).toContainEqual({ type: 'usage', usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } });

expect(p.parseLine(JSON.stringify({ type: 'error', message: 'request failed' }))[0]).toMatchObject({
  type: 'error', error: expect.objectContaining({ message: 'request failed' }),
});
```

- [x] **Step 3: Run the provider tests and verify RED**

Run: `npx vitest run src/lib/agents/providers.test.ts --reporter=dot`

Expected: failures show the missing `exec --json`, obsolete `--full-auto`, and text-only parsing.

- [x] **Step 4: Implement minimal command and event mapping**

Set capabilities to `streaming`, `structured-output`, `usage`, and `interactive`. Build exact argv by execution mode and parse only documented Codex shapes:

```ts
if (options.executionMode === 'batch') {
  argv.push('exec', '--json');
} else {
  argv.push('--no-alt-screen');
}
argv.push('--dangerously-bypass-approvals-and-sandbox', '-C', options.worktreePath);
```

Use snake_case token fields from Codex and return `text` for valid but unhandled events or malformed lines. Do not add resume support.

- [x] **Step 5: Run provider tests and verify GREEN**

Run: `npx vitest run src/lib/agents/providers.test.ts --reporter=dot`

Expected: all provider and registry tests pass.

- [x] **Step 6: Commit the provider contract**

```bash
git add src/lib/agents/codex.ts src/lib/agents/providers.test.ts
git commit -m "fix(agent): implement codex cli protocol"
```

### Task 2: Propagate explicit provider selection through loop and QA

**Files:**
- Modify: `src/commands/loop.ts`
- Modify: `src/commands/qa.ts`
- Modify: `src/commands/backlog.test.ts`
- Modify: `src/lib/core/config/manager.ts`
- Modify: `tests/config.test.ts`
- Modify: `src/lib/workflows/run-request.ts`
- Modify: `src/lib/workflows/run-request.test.ts`
- Modify: `src/lib/modules/loop-runner.ts`
- Modify: `src/lib/modules/loop-runner.test.ts`
- Modify: `src/lib/modules/qa-runner.ts`
- Modify: `src/lib/modules/qa-runner.test.ts`

- [x] **Step 1: Write failing CLI surface tests**

Register loop alongside run and QA, then assert all three canonical execution commands expose `--agent`:

```ts
expect(run?.options.some(option => option.long === '--agent')).toBe(true);
expect(loop?.options.some(option => option.long === '--agent')).toBe(true);
expect(qa?.options.some(option => option.long === '--agent')).toBe(true);
```

- [x] **Step 2: Write a failing LoopRunner cross-phase propagation test**

Construct LoopRunner with `agentProvider: 'codex'`, capture WorkflowRunner `.run()` options and the config passed to `qaRunnerFactory`, then assert:

```ts
expect(run).toHaveBeenCalledWith(expect.objectContaining({ agentProvider: 'codex' }));
expect(qaFactory).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ agentDefault: 'codex' }));
```

The fixture must return implementation success, enqueue QA, set the backlog to `verification`, and execute the queued QA segment.

- [x] **Step 3: Write a failing QARunner config selection test**

Register a fake named `codex`, construct QARunner with `{ ...config, agentDefault: 'codex' }` and no injected agent provider, then assert the runner resolves that fake provider.

Also update the config regression to expect the canonical default `claude-code`, and assert `resolveWorkflowRequest()` accepts `codex` but rejects the removed `claude` alias.

- [x] **Step 4: Run focused tests and verify RED**

Run:

```bash
npx vitest run \
  src/commands/backlog.test.ts \
  tests/config.test.ts \
  src/lib/workflows/run-request.test.ts \
  src/lib/modules/loop-runner.test.ts \
  src/lib/modules/qa-runner.test.ts \
  --reporter=dot
```

Expected: CLI options are absent and loop/QA select `claude-code`.

- [x] **Step 5: Implement canonical provider-name validation**

Export a resolver beside the agent factory:

```ts
export function resolveAgentProviderName(raw: string = 'claude-code'): AgentProviderName {
  const name = raw as AgentProviderName;
  ensureBuiltinAgentProviders();
  requireAgentProvider(name);
  return name;
}
```

Change `DEFAULT_WORKFLOW.agentDefault` to `claude-code` and delete the `config.agentDefault === 'claude'` alias branch from `resolveWorkflowRequest`. Use the resolver for config/CLI boundaries so invalid providers fail before worktree creation. Do not add compatibility branches elsewhere.

- [x] **Step 6: Implement CLI and runner propagation**

Add `['--agent <name>', 'Agent provider']` to loop start options and `.option('--agent <name>', 'Agent provider')` to QA. Add `agentProvider?: AgentProviderName` to LoopRunnerOptions and InternalOptions. Resolve the selected name once and:

```ts
await runner.run({
  // existing fields
  agentProvider: this.opts.agentProvider,
});
```

For QA, pass a config copy with `agentDefault: this.opts.agentProvider`. QARunner uses `createAgentProvider(resolveAgentProviderName(this.config.agentDefault))` when no provider dependency is injected.

- [x] **Step 7: Run focused tests and verify GREEN**

Run the Step 4 command again.

Expected: all command, loop, and QA tests pass.

- [x] **Step 8: Commit provider propagation**

```bash
git add src/commands/loop.ts src/commands/qa.ts src/commands/backlog.test.ts \
  src/lib/core/config/manager.ts tests/config.test.ts \
  src/lib/workflows/run-request.ts src/lib/workflows/run-request.test.ts \
  src/lib/modules/loop-runner.ts src/lib/modules/loop-runner.test.ts \
  src/lib/modules/qa-runner.ts src/lib/modules/qa-runner.test.ts src/lib/agents/index.ts
git commit -m "feat(agent): propagate codex through loop qa"
```

### Task 3: Prove Codex-compatible streaming completion

**Files:**
- Modify: `src/lib/sandbox/providers/streaming.test.ts`

- [x] **Step 1: Write the Codex JSONL fixture test**

Use a real `CodexProvider` with a Node command that reads stdin and emits these newline-delimited events:

```ts
{ type: 'thread.started', thread_id: 'fixture-thread' }
{ type: 'item.completed', item: { type: 'agent_message', text: '<goal_complete>{"type":"goal_complete","kind":"task","summary":"codex fixture complete"}</goal_complete>' } }
{ type: 'turn.completed', usage: { input_tokens: 12, cached_input_tokens: 2, output_tokens: 5 } }
```

Assert `waitForResult()` returns `status: 'completed'`, the structured task payload, and normalized usage when usage arrives before process completion.

- [x] **Step 2: Run the streaming test and verify it passes through production parsing**

Run: `npx vitest run src/lib/sandbox/providers/streaming.test.ts --reporter=dot`

Expected: the new Codex fixture and all existing streaming cases pass. If it fails because completion terminates before the usage line, reorder the fixture so usage precedes the final agent message; do not weaken production completion behavior.

- [x] **Step 3: Commit the integration fixture**

```bash
git add src/lib/sandbox/providers/streaming.test.ts
git commit -m "test(agent): cover codex streaming completion"
```

### Task 4: Document and verify the explicit Codex workflow

**Files:**
- Modify: `docs/WORKFLOWS.md`
- Modify: `docs/WORKFLOWS_zh.md`

- [x] **Step 1: Document direct CLI selection**

Add matching English and Chinese examples:

```bash
afk run --backlog-id 123 --agent codex --execution-mode batch
afk qa --backlog-id 123 --agent codex --mode batch
afk loop --agent codex --max-iterations 1
```

State that Claude Code remains default, Codex must resolve from `PATH`, AFK supplies its prompt over stdin in batch mode, and the runtime projection records the selected provider.

- [x] **Step 2: Run static and full automated verification**

Run:

```bash
npm run typecheck
npm run build
npm test -- --reporter=dot
git diff --check
```

Expected: typecheck/build exit 0, full Vitest suite has 0 failures, and diff check emits no output.

- [x] **Step 3: Commit documentation**

```bash
git add docs/WORKFLOWS.md docs/WORKFLOWS_zh.md
git commit -m "docs(agent): document codex execution"
```

### Task 5: Run the real Codex backlog lifecycle

**Files:**
- No production files; collect evidence from provider state, runtime diagnostics, git branches, and the created change request.

- [ ] **Step 1: Verify the host CLI without changing production resolution**

Run:

```bash
PATH="/Applications/ChatGPT.app/Contents/Resources:$PATH" codex --version
PATH="/Applications/ChatGPT.app/Contents/Resources:$PATH" codex login status
```

Expected: a working Codex version and authenticated status. If either fails, stop and report the environment blocker; do not claim E2E success.

- [ ] **Step 2: Create a bounded AFK backlog**

Create a root backlog whose acceptance criteria require one small, testable repository change and no unrelated refactoring. Record its backlog URL and ID. Ensure its execution mode is `afk` and state is `ready`.

- [ ] **Step 3: Run one complete loop iteration using Codex**

Run:

```bash
PATH="/Applications/ChatGPT.app/Contents/Resources:$PATH" \
  afk loop --agent codex --max-concurrent 1 --poll-interval 5 \
  --status-interval 5 --max-iterations 1
```

Expected: implement is claimed with `agentProvider=codex`, reaches verification, QA starts with `agentProvider=codex`, and loop stops after the QA terminal result.

- [ ] **Step 4: Audit runtime and provider evidence**

Inspect `afk loop status`, the Tasks TUI, `~/.afk/runs`, AFK logs, backlog state/tags, the feature/QA branches, and the change request. Confirm implementation and QA both used Codex, `goal_complete` was parsed, root backlog ends `merge_ready + hitl`, and the change request targets `main` without auto-merge.

- [ ] **Step 5: Run final repository verification**

Run:

```bash
npm test -- --reporter=dot
git status --short --branch
git log --oneline --decorate -5
```

Expected: 0 test failures, only intentional commits/files remain, and no generated AFK signal/runtime artifact is staged.
