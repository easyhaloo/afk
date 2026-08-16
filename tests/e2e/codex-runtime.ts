import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import simpleGit from 'simple-git';
import {
  prepareAgentRuntime,
  resolveCodexRuntime,
  type CodexRuntimeSelection,
  type CodexTransport,
} from '../../src/lib/agents';
import type { BacklogProvider } from '../../src/lib/core/backlog';
import { BACKLOG_METADATA } from '../../src/lib/core/backlog';
import { getWorkflowConfig } from '../../src/lib/core/config/manager';
import { createProviderBundle as assembleProviderBundle } from '../../src/lib/core/providers';
import { createTrackerClient } from '../../src/lib/client-factory';
import { LoopRunner } from '../../src/lib/modules/loop-runner';
import { TaskRuntimeManager } from '../../src/lib/runtime/task-runtime';

const E2E_TIMEOUT_MS = positiveInteger(process.env.AFK_CODEX_E2E_TIMEOUT_MS) ?? 30 * 60_000;

async function main(): Promise<void> {
  const transport = parseTransport(process.argv.slice(2));
  const workflow = getWorkflowConfig();
  const unresolvedRuntime = resolveCodexRuntime({
    cli: {
      transport,
      ...(transport === 'app-server' ? { endpoint: 'stdio://' } : {}),
    },
    config: workflow.agents.codex,
  });

  // Readiness must happen before a tracker client or backlog is created.
  const runtime = await prepareAgentRuntime(unresolvedRuntime);
  const tracker = await createTrackerClient(undefined, process.cwd());
  const providers = assembleProviderBundle(tracker, process.cwd());
  await providers.backlog.initialize();

  const createdAt = Date.now();
  const marker = new Date(createdAt).toISOString().replaceAll(/[-:.TZ]/g, '');
  const title = `[Codex E2E] ${transport} runtime ${marker}`;
  const fixturePath = `tests/fixtures/afk-codex-e2e-${marker}.txt`;
  const fixtureContent = `codex ${transport} e2e ${marker}`;
  const backlogId = String(await tracker.createIssue({
    title,
    description: buildDescription(fixturePath, fixtureContent),
    labels: [
      BACKLOG_METADATA.stateLabels.ready,
      BACKLOG_METADATA.executionModeLabels.afk,
    ],
  }));
  const initial = await providers.backlog.get(backlogId);
  const runtimeDir = await mkdtemp(join(tmpdir(), 'afk-codex-e2e-'));
  const runner = new LoopRunner(providers, {
    providers,
    agentProvider: 'codex',
    agentRuntime: runtime,
    backlogIds: [backlogId],
    readinessProbe: async selected => ({
      ready: true,
      auth: selected.auth,
      provider: selected.provider,
    }),
    maxConcurrent: 1,
    maxIterations: 1,
    pollIntervalMs: 1_000,
    statusIntervalMs: 2_000,
    shutdownTimeoutMs: 30_000,
    pidFilePath: join(runtimeDir, 'loop.pid'),
    statusFilePath: join(runtimeDir, 'loop-status.json'),
  });

  console.log(`Codex E2E backlog: ${initial.webUrl ?? backlogId}`);
  console.log(`Codex runtime: transport=${runtime.transport} auth=${runtime.auth} provider=${runtime.provider}`);

  try {
    const loop = runner.start();
    const final = await waitForTerminal(providers.backlog, backlogId, loop, E2E_TIMEOUT_MS);
    await runner.stop();
    await loop;

    assert.equal(final.state, 'merge_ready', `backlog ended in ${final.state}`);
    assert.equal(final.executionMode, 'hitl', `backlog ended in mode ${final.executionMode}`);
    await assertRuntimeEvidence(backlogId, runtime, createdAt);

    const change = (await tracker.listMRs({ state: 'opened', perPage: 100 }))
      .find(candidate => candidate.title === `Backlog ${backlogId}: ${title}`);
    assert(change, 'root backlog did not create an open merge request');
    assert.equal(change.sourceBranch, `${final.branchName}-qa`, 'merge request source branch does not match the QA branch');
    assert.equal(change.targetBranch, workflow.targetBranch, 'root backlog merge request targets the wrong baseline');
    await assertRemoteFixture(change.sourceBranch, fixturePath, fixtureContent);
    console.log(`Codex E2E merge request: ${change.url}`);
    console.log(`Codex E2E passed: backlog=${backlogId} state=merge_ready mode=hitl`);
  } catch (error) {
    await runner.stop().catch(() => {});
    const current = await providers.backlog.get(backlogId).catch(() => undefined);
    console.error(`Codex E2E failed: backlog=${initial.webUrl ?? backlogId} state=${current?.state ?? 'unknown'} mode=${current?.executionMode ?? 'unknown'}`);
    throw error;
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
}

function parseTransport(args: string[]): Exclude<CodexTransport, 'auto'> {
  const inline = args.find(arg => arg.startsWith('--transport='))?.slice('--transport='.length);
  const index = args.indexOf('--transport');
  const value = inline ?? (index >= 0 ? args[index + 1] : 'exec');
  if (value !== 'exec' && value !== 'app-server') {
    throw new Error('Codex E2E transport must be exec or app-server');
  }
  return value;
}

function buildDescription(fixturePath: string, fixtureContent: string): string {
  return [
    '## Goal',
    '',
    `Create \`${fixturePath}\` containing exactly one line:`,
    '',
    '```text',
    fixtureContent,
    '```',
    '',
    'Do not modify any other tracked file.',
    '',
    '## Acceptance Criteria',
    '',
    `- [ ] \`${fixturePath}\` exists and contains the exact required line.`,
    '- [ ] `npm run typecheck` succeeds.',
    '- [ ] The implementation is committed and pushed to the backlog branch.',
  ].join('\n');
}

async function waitForTerminal(
  backlog: BacklogProvider,
  backlogId: string,
  loop: Promise<void>,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let loopStopped = false;
  let loopFailure: unknown;
  void loop.then(
    () => { loopStopped = true; },
    error => { loopFailure = error; },
  );
  while (Date.now() < deadline) {
    const current = await backlog.get(backlogId);
    if (current.state === 'merge_ready' && current.executionMode === 'hitl') return current;
    if (current.state === 'blocked' || current.state === 'done') return current;
    if (loopFailure) throw loopFailure;
    if (loopStopped) throw new Error(`loop stopped while backlog was ${current.state}`);
    await delay(1_000);
  }
  throw new Error(`Codex E2E timed out after ${timeoutMs}ms`);
}

async function assertRuntimeEvidence(
  backlogId: string,
  runtime: CodexRuntimeSelection,
  startedAt: number,
): Promise<void> {
  const manager = new TaskRuntimeManager();
  const records = (await manager.store.listArchive()).filter(record =>
    record.backlogId === backlogId && Date.parse(record.startedAt) >= startedAt,
  );
  const implementation = records.filter(record => record.phase === 'implementing');
  const verification = records.filter(record => record.phase === 'verifying');
  assert(implementation.length > 0, 'Tasks archive is missing implementation runtime');
  assert(verification.length > 0, 'Tasks archive is missing QA runtime');
  for (const record of records) {
    assert.equal(record.agentProvider, 'codex');
    assert.equal(record.agentTransport, runtime.transport);
    assert.equal(record.agentAuth, runtime.auth);
    assert.equal(record.agentModelProvider, runtime.provider);
    if (runtime.transport === 'app-server') {
      assert(record.agentThreadId, `${record.phase} runtime is missing app-server thread ID`);
    }
  }

  const readResult = async (record: typeof records[number]) => {
    try {
      return JSON.parse(await readFile(join(record.diagnosticPath!, 'result.json'), 'utf8')) as {
        structuredOutput?: { type?: string; kind?: string; result?: string };
      };
    } catch {
      return undefined;
    }
  };
  const implementationResults = await Promise.all(implementation.map(readResult));
  const verificationResults = await Promise.all(verification.map(readResult));
  assert(
    implementationResults.some(result => result?.structuredOutput?.type === 'goal_complete'),
    'implementation diagnostics did not capture goal_complete',
  );
  assert(
    verificationResults.some(result =>
      result?.structuredOutput?.type === 'goal_complete'
      && result.structuredOutput.kind === 'qa'
      && result.structuredOutput.result === 'PASS'),
    'QA diagnostics did not capture a passing goal_complete',
  );
}

async function assertRemoteFixture(
  sourceBranch: string,
  fixturePath: string,
  fixtureContent: string,
): Promise<void> {
  const git = simpleGit(process.cwd());
  await git.fetch('origin', sourceBranch);
  const remoteContent = await git.show([`FETCH_HEAD:${fixturePath}`]);
  assert.equal(remoteContent, `${fixtureContent}\n`, 'merge request source branch has unexpected fixture content');
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('AFK_CODEX_E2E_TIMEOUT_MS must be a positive integer');
  return parsed;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
