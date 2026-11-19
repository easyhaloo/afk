import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export async function checkBudgetReentry({ runner, receipt, store, item, template, workspace, workItemId, branchName, ledger, transcripts }) {
  const before = await ledger.load();
  const initialFiles = transcripts();
  const nextRun = randomUUID();
  item.state = 'ready';
  const result = await runner.run({ backlogId: item.id, workItemId, observationWorkItemId: workItemId, observationRunId: nextRun,
    session: receipt.runId, repoRoot: workspace, workspaceRoot: workspace, targetBranch: branchName, baseBranch: 'main',
    baseBranchExplicit: true, template, agentProvider: 'codex', executionMode: 'batch', maxTotalTokens: before.tokens, maxHandoffs: 1 });
  assert.equal(result.success, false);
  assert.equal(item.state, 'blocked');
  assert.ok((await store.verify(nextRun)).valid);
  const events = [];
  for await (const event of store.read(nextRun)) events.push(event.data);
  assert.deepEqual(events.filter(event => event.kind === 'run.finished').map(event => [event.outcome, event.reasonCode]), [['failed', 'budget_exhausted']]);
  assert.equal(events.some(event => event.kind === 'agent.session_recorded'), false);
  assert.deepEqual(await ledger.load(), before);
  assert.deepEqual(transcripts(), initialFiles);
  receipt.reentry = { state: item.state, outcome: 'failed', reasonCode: 'budget_exhausted', newThreads: 0, budgetAfter: before.tokens };
}

export async function qualifyResume({ load, runtime, runner, receipt, store, item, template, workspace, workItemId, branchName }) {
  const { createAgentProvider, guardedRestoreSession } = await load('domain/agents/index');
  const { attemptNativeResume } = await load('application/workflows/resume');
  const { BudgetStore } = await load('application/workflows/budget-store');
  const { prepareAgentRuntime, resolveCodexRuntime, DEFAULT_CODEX_CONFIG } = await load('domain/agents/codex-runtime');
  const provider = createAgentProvider('codex');
  const ledger = new BudgetStore(workspace, workItemId);
  const before = await ledger.load();
  const sessionsDir = join(process.env.CODEX_HOME, 'sessions');
  const transcripts = () => readdirSync(sessionsDir, { recursive: true }).filter(name => name.endsWith('.jsonl')).sort();
  const initialFiles = transcripts();
  const original = receipt.sessionId;
  receipt.phase = 'resume-capability';
  receipt.resumeAdvertised = provider.capabilities.has('resume');
  assert.deepEqual(before.sessions, { [original]: receipt.nativeTokens });
  assert.equal(before.tokens, receipt.nativeTokens);
  receipt.budgetBefore = before.tokens;
  const sandbox = { worktreePath: workspace, workspacePath: workspace };
  const snapshot = { sessionId: original, generation: 0, summary: 'synthetic', capturedAt: new Date().toISOString(),
    checkpoint: { version: 1, provider: 'codex', sessionId: original, worktreePath: workspace } };
  const context = { iid: 1, session: receipt.runId, wtPath: workspace, runId: receipt.runId, generation: 1,
    signalType: 'goal_complete', executionMode: 'batch', runtime,
    prompt: 'Reply only with <goal_complete>{"type":"goal_complete","kind":"task","summary":"done"}</goal_complete>.' };
  const unexpected = () => assert.fail('unsupported resume accessed checkpoint storage or started a generation');
  assert.equal(await attemptNativeResume(context, provider, sandbox, unexpected, unexpected), undefined);
  await assert.rejects(guardedRestoreSession(provider, { snapshot, worktreePath: workspace }),
    receipt.resumeAdvertised ? /invalid codex native session snapshot/i : /does not support resume; use handoff Markdown fallback instead/);
  receipt.workflowResume = 'skipped_unsupported_host';
  const options = { ...context, sandbox, worktreePath: workspace, sessionId: context.session, resume: snapshot };
  const execRuntime = await prepareAgentRuntime(resolveCodexRuntime({ cli: { transport: 'exec' }, config: DEFAULT_CODEX_CONFIG }));
  await assert.rejects(provider.createExecution({ ...options, runtime: execRuntime }), /codex does not support explicit native resume/);
  receipt.execResume = 'rejected_unsupported';
  assert.deepEqual(transcripts(), initialFiles);

  receipt.phase = 'budget-reentry';
  await checkBudgetReentry({ runner, receipt, store, item, template, workspace, workItemId, branchName, ledger, transcripts });

  receipt.phase = 'explicit-app-server-resume';
  if (receipt.resumeAdvertised) {
    const { LocalSandbox } = await load('infrastructure/sandbox/providers/local');
    const local = new LocalSandbox({ id: 'qualification', sessionName: 'qualification', worktreePath: workspace });
    await assert.rejects(provider.createExecution({ ...options, sandbox: local }), /invalid codex native session snapshot/i);
    const first = await provider.createExecution({ ...options, sandbox: local, generation: 1, resume: undefined });
    const initial = await first.waitForResult({ completionTimeoutMs: 60000 });
    assert.equal(initial.status, 'completed');
    const saved = await first.captureSession();
    assert.equal(saved.sessionId, first.metadata.threadId);
    const resumed = await first.resume({ snapshot: saved, prompt: context.prompt });
    const next = await resumed.waitForResult({ completionTimeoutMs: 60000 });
    assert.equal(next.status, 'completed');
    assert.equal(resumed.metadata.threadId, saved.sessionId);
    const added = transcripts().filter(file => !initialFiles.includes(file));
    assert.equal(added.length, 1);
    assert.ok(added[0].endsWith(`${saved.sessionId}.jsonl`));
    const native = readFileSync(join(sessionsDir, added[0]), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const cumulative = native.findLast(row => row.payload?.info?.total_token_usage)?.payload.info.total_token_usage.total_tokens;
    assert.ok(next.usage?.totalTokens > 0);
    assert.equal(initial.usage.totalTokens + next.usage.totalTokens, cumulative);
    receipt.nativeResume = { sameThread: true, threads: added.length, first: initial.usage.totalTokens, resumed: next.usage.totalTokens, cumulative };
    return;
  }
  let execution;
  try {
    execution = await provider.createExecution(options);
  } catch (error) {
    assert.match(error.message, /does not support.*resume|resume.*unsupported/i);
    assert.deepEqual(transcripts(), initialFiles);
    receipt.appServerResume = 'rejected_unsupported';
    return;
  }
  try {
    const response = await execution.waitForResult({ completionTimeoutMs: 60000 });
    const actual = execution.metadata.threadId;
    assert.match(actual, /^[0-9a-f-]{36}$/);
    const file = transcripts().find(name => name.endsWith(`${actual}.jsonl`));
    const rows = readFileSync(join(sessionsDir, file), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const tokens = rows.findLast(row => Number.isFinite(row.payload?.info?.total_token_usage?.total_tokens))?.payload.info.total_token_usage.total_tokens;
    receipt.explicitStart = { sameNativeThread: actual === original, nativeIdentityVerified: rows.some(row => row.type === 'session_meta' && row.payload.id === actual),
      status: response.status, productTokens: response.usage?.totalTokens, nativeTokens: tokens, budgetAfter: (await ledger.load()).tokens };
    assert.ok(receipt.explicitStart.nativeIdentityVerified);
    assert.equal(response.status, 'completed');
    assert.ok(tokens > 0);
    assert.equal(response.usage?.totalTokens, tokens);
    receipt.appServerResume = actual === original ? 'accepted_original_thread' : 'started_different_thread';
    await assert.rejects(execution.resume({ snapshot }), /does not support resume/);
    receipt.executionResume = 'rejected_unsupported';
    assert.fail('provider accepted explicit resume despite missing capability');
  } finally { await execution.kill(); }
}
