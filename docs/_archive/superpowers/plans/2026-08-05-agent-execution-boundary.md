# Agent Execution Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make automatic AFK execution run provider commands through one typed batch execution path, with tmux reserved for explicit HITL interaction.

**Architecture:** Sandbox creation provisions isolation only. `Sandbox.startAgent()` launches the selected provider's `AgentCommand` and returns an `AgentExecution` with a typed result. `WorkflowRunner`, `LoopRunner`, and `QARunner` request batch execution for automation and use the result to advance the existing backlog lifecycle.

**Tech Stack:** TypeScript, Node child processes, Vitest.

---

## File Structure

- Modify: `src/lib/agents/claude-code.ts` and `src/lib/sandbox/providers/streaming.ts` for truthful batch capability and result parsing.
- Modify: `src/lib/sandbox/providers/local.ts` and `src/lib/sandbox/types.ts` so provisioning cannot launch an agent.
- Modify: `src/lib/workflows.ts`, `src/lib/modules/loop-runner.ts`, and `src/lib/modules/qa-runner.ts` for explicit batch automation.
- Modify: `src/lib/core/tmux/tmux.ts` to retain attach operations while removing automation readiness from its contract.
- Add focused tests beside each modified execution module.

### Task 1: Define truthful batch results

**Files:**
- Modify: `src/lib/agents/claude-code.ts`
- Modify: `src/lib/sandbox/providers/streaming.ts`
- Modify: `src/lib/sandbox/providers/streaming.test.ts`

- [ ] **Step 1: Write failing tests.**

```ts
it('declares Claude batch output as structured streaming', () => {
  expect(new ClaudeCodeProvider().capabilities).toContain('structured-output');
});

it('fails when batch output lacks the requested completion signal', async () => {
  await expect(execution.waitForResult()).resolves.toMatchObject({
    status: 'failed', error: { code: 'MISSING_RESULT' },
  });
});
```

- [ ] **Step 2: Verify RED.**

Run: `pnpm exec vitest run src/lib/sandbox/providers/streaming.test.ts src/lib/agents/providers.test.ts`

Expected: FAIL because the structured-output capability or requested-signal validation is absent.

- [ ] **Step 3: Implement the minimal batch contract.**

```ts
const CAPABILITIES = new Set<AgentCapability>([
  'streaming', 'structured-output', 'usage', 'resume', 'interactive',
]);

return isExpectedSignal(this.structuredOutput, this.signalType)
  ? completedResult
  : failedResult('MISSING_RESULT');
```

Keep bounded stdout/stderr for `captureOutput()` and return stderr in non-zero result errors.

- [ ] **Step 4: Verify GREEN.**

Run: `pnpm exec vitest run src/lib/sandbox/providers/streaming.test.ts src/lib/agents/providers.test.ts && pnpm typecheck`

Expected: PASS.

### Task 2: Separate sandbox provisioning from launch

**Files:**
- Modify: `src/lib/sandbox/providers/local.ts`
- Modify: `src/lib/sandbox/types.ts`
- Create: `src/lib/sandbox/providers/local.test.ts`

- [ ] **Step 1: Write failing tests.**

```ts
it('provisions a batch sandbox without creating tmux', async () => {
  await provider.create({ worktreePath: '/repo', session: 's', executionMode: 'batch' });
  expect(tmux.createSession).not.toHaveBeenCalled();
});

it('starts batch work using the exact provider command', async () => {
  const execution = await sandbox.startAgent({
    command: { argv: ['agent', '--json'], cwd: '/repo' }, prompt: 'goal',
    generation: 1, signalType: 'goal_complete', executionMode: 'batch', agentProvider,
  });
  expect(execution).toBeInstanceOf(StreamingAgentExecution);
});
```

- [ ] **Step 2: Verify RED.**

Run: `pnpm exec vitest run src/lib/sandbox/providers/local.test.ts`

Expected: FAIL with `tmux.createSession` called from `create()`.

- [ ] **Step 3: Implement provision-only creation.**

```ts
async create(options: SandboxOptions): Promise<Sandbox> {
  await fs.access(options.worktreePath);
  return new LocalSandbox({ ...options, id: randomUUID() });
}

if (options.executionMode === 'batch') return startStreaming(options);
if (options.executionMode === 'interactive') return startInteractiveTmux(options);
throw new Error('execution mode is required');
```

Interactive launch must execute `options.command.argv` and include worktree, session, pane capture, and process diagnostics on launch failure. Batch must never call `waitForPrompt`.

- [ ] **Step 4: Verify GREEN.**

Run: `pnpm exec vitest run src/lib/sandbox/providers/local.test.ts src/lib/sandbox/providers/streaming.test.ts && pnpm typecheck`

Expected: PASS.

### Task 3: Route automation through batch

**Files:**
- Modify: `src/lib/workflows.ts`
- Modify: `src/lib/modules/loop-runner.ts`
- Modify: `src/lib/workflows/backlog-provider.test.ts`
- Modify: `src/lib/modules/loop-runner.test.ts`

- [ ] **Step 1: Write failing tests.**

```ts
it('starts automatic workflow steps in batch mode', async () => {
  await runner.run(request);
  expect(sandbox.startAgent).toHaveBeenCalledWith(expect.objectContaining({ executionMode: 'batch' }));
});

it('passes batch mode from loop chains', async () => {
  await loop.start();
  expect(workflowRunner.run).toHaveBeenCalledWith(expect.objectContaining({ executionMode: 'batch' }));
});
```

- [ ] **Step 2: Verify RED.**

Run: `pnpm exec vitest run src/lib/workflows/backlog-provider.test.ts src/lib/modules/loop-runner.test.ts`

Expected: FAIL because execution mode is undefined or interactive.

- [ ] **Step 3: Implement explicit automatic batch mode.**

```ts
const executionMode = options.executionMode ?? 'batch';
await this.sandboxProvider.create({ worktreePath: wt.path, session, branch: targetBranch, tmux: this.tmux, executionMode });
```

`LoopRunner.runChain()` passes `executionMode: 'batch'`. Reject a batch provider without both `streaming` and `structured-output` before creating a sandbox.

- [ ] **Step 4: Verify GREEN.**

Run: `pnpm exec vitest run src/lib/workflows/backlog-provider.test.ts src/lib/modules/loop-runner.test.ts && pnpm typecheck`

Expected: PASS.

### Task 4: Use the same boundary for QA

**Files:**
- Modify: `src/lib/modules/qa-runner.ts`
- Modify: `src/lib/modules/qa-runner.test.ts`
- Modify: `src/lib/core/tmux/tmux.ts`

- [ ] **Step 1: Write a failing QA test.**

```ts
it('executes QA in batch mode without prompt readiness polling', async () => {
  await qa.process('60');
  expect(sandbox.startAgent).toHaveBeenCalledWith(expect.objectContaining({ executionMode: 'batch' }));
  expect(tmux.waitForPrompt).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Verify RED.**

Run: `pnpm exec vitest run src/lib/modules/qa-runner.test.ts`

Expected: FAIL because `QARunner` directly creates a tmux session.

- [ ] **Step 3: Implement shared QA execution.**

Build the provider command, start it through a sandbox with `executionMode: 'batch'`, and require completed execution plus existing AC PASS semantics before merge. Remove direct QA calls to `createSession`, `waitForPrompt`, and `sendPrompt`.

- [ ] **Step 4: Verify GREEN.**

Run: `pnpm exec vitest run src/lib/modules/qa-runner.test.ts src/lib/modules/loop-runner.test.ts && pnpm typecheck`

Expected: PASS.

### Task 5: Verify terminal routing and retry workflow

**Files:**
- Modify: `src/lib/modules/loop-runner.test.ts`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/WORKFLOWS.md`

- [ ] **Step 1: Write a failing no-tmux routing test.**

```ts
it('routes a batch launch failure to blocked hitl without prompt polling', async () => {
  await loop.start();
  expect(backlog.transition).toHaveBeenCalledWith('60', 'blocked', expect.anything());
  expect(backlog.setExecutionMode).toHaveBeenCalledWith('60', 'hitl');
  expect(tmux.waitForPrompt).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Implement the terminal contract.**

Document batch as the automatic protocol and tmux attach as HITL-only. Preserve `blocked / hitl` for launch error, non-zero exit, missing structured result, timeout, and QA failure.

- [ ] **Step 3: Verify complete behavior.**

Run: `pnpm typecheck && pnpm build && pnpm exec vitest run --exclude 'tests/e2e/**' --reporter=verbose && pnpm exec vitest run tests/e2e/notification.test.ts tests/e2e/dashboard-layout.test.ts --reporter=verbose && git diff --check`

Expected: all commands exit 0. Requeue backlog `#60` only after these tests pass, then run one single-item loop retry.
