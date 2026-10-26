import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import simpleGit from 'simple-git';
import {
  prepareAgentRuntime,
  resolveCodexRuntime,
  type CodexRuntimeSelection,
  type CodexTransport,
} from '@afk/runtime/domain/agents/index';
import { BACKLOG_METADATA } from '@afk/runtime/domain/backlog/index';
import { getWorkflowConfig } from '@afk/runtime/infrastructure/config/manager';
import { createProviderBundle as assembleProviderBundle } from '@afk/runtime/infrastructure/provider/providers';
import { createTracker } from '@afk/runtime/infrastructure/provider/tracker-provider-factory';
import type { TrackerProvider } from '@afk/runtime/domain/tracker/types';
import { LoopRunner } from '@afk/runtime/application/runners/loop-runner';
import { TaskRuntimeManager } from '@afk/runtime/application/runtime/task-runtime';
import { deriveBacklogBranchName } from '@afk/runtime/domain/backlog/index';
import { formatWorkItemId } from '@afk/runtime/domain/work-item/identity';
import { toGlobalWorkItem } from '@afk/runtime/domain/work-item/metadata';
import { executeWorkItem } from '@afk/runtime/execution';
import { waitForTerminal } from './codex-runtime-wait.js';

const E2E_PHASE_TIMEOUT_MS = positiveInteger(process.env.AFK_CODEX_E2E_TIMEOUT_MS) ?? 30 * 60_000;

async function main(): Promise<void> {
  const transport = parseTransport(process.argv.slice(2));
  console.log(`Codex E2E phase deadline: ${E2E_PHASE_TIMEOUT_MS}ms each for implementation and QA (${process.env.AFK_CODEX_E2E_TIMEOUT_MS === undefined ? 'default' : 'AFK_CODEX_E2E_TIMEOUT_MS'})`);
  const workflow = getWorkflowConfig();
  workflow.agentDefault = 'codex';
  workflow.agents.codex.transport = transport;
  if (transport === 'app-server') workflow.agents.codex.appServer.endpoint = 'stdio://';
  const unresolvedRuntime = resolveCodexRuntime({
    cli: {
      transport,
      ...(transport === 'app-server' ? { endpoint: 'stdio://' } : {}),
    },
    config: workflow.agents.codex,
  });

  // Readiness must happen before a tracker client or backlog is created.
  const runtime = await prepareAgentRuntime(unresolvedRuntime);
  if (runtime.kind !== 'codex') {
    throw new Error(`codex E2E requires a codex runtime, resolved ${runtime.kind}`);
  }
  const tracker = await createTracker(undefined, process.cwd());
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
  const issue = await tracker.getIssue(Number(backlogId));
  const runtimeDir = await mkdtemp(join(tmpdir(), 'afk-codex-e2e-'));
  const projectKey = tracker.platform === 'gitlab'
    ? `${tracker.providerHost}/${String(tracker.projectId).replace(`${tracker.providerHost}/`, '')}`
    : String(tracker.projectId);
  const workItemId = formatWorkItemId({ platform: tracker.platform, projectKey, issueNumber: Number(backlogId) });
  const inventoryItem = toGlobalWorkItem({
    platform: tracker.platform,
    projectKey,
    ...(tracker.providerHost ? { providerHost: tracker.providerHost } : {}),
    ...(tracker.platform === 'gitlab' ? { providerProjectId: String(tracker.projectId) } : {}),
    name: projectKey.split('/').at(-1) ?? projectKey,
    defaultBranch: workflow.targetBranch,
  }, {
    issueNumber: issue.id,
    title: issue.title,
    description: issue.description,
    labels: issue.labels,
    state: issue.state === 'closed' ? 'closed' : 'opened',
    webUrl: issue.url,
  });
  const workspaceRoot = dirname(process.cwd());
  const workingBranch = deriveBacklogBranchName(backlogId);
  const manifestPath = join(workspaceRoot, '.afk', 'e2e-runtime', `manifest-${marker}.json`);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify({
    schemaVersion: 1,
    workItemId,
    providerBacklogId: backlogId,
    tracker: {
      platform: tracker.platform,
      projectKey,
      ...(tracker.providerHost ? { providerHost: tracker.providerHost } : {}),
      ...(tracker.platform === 'gitlab' ? { providerProjectId: String(tracker.projectId) } : {}),
    },
    workingBranch,
    repositories: [{
      platform: tracker.platform,
      projectKey,
      ...(tracker.providerHost ? { providerHost: tracker.providerHost } : {}),
      ...(tracker.platform === 'gitlab' ? { providerProjectId: String(tracker.projectId) } : {}),
      name: basename(process.cwd()),
      checkoutPath: basename(process.cwd()),
      baseBranch: workflow.targetBranch,
      workingBranch,
      primary: true,
    }],
  }, null, 2));
  // The runner takes no agent provider or runtime: the agent and its runtime
  // are derived from the workflow config (agentDefault + agents.codex) inside
  // `executeWorkItem`, exactly like `afk loop` does in production. Passing
  // them here was silently ignored.
  const runner = new LoopRunner(providers, {
    backlogIds: [backlogId],
    managedExecution: { workItemId, manifestPath },
    template: 'issue-implementation',
    executeManagedWorkItem: input => executeWorkItem(input, {
      lookupWorkItem: async id => {
        if (id !== workItemId) throw new Error(`unexpected E2E work item lookup: ${id}`);
        return inventoryItem;
      },
    }),
    maxIterations: 1,
    pollIntervalMs: 10_000,
    statusIntervalMs: 10_000,
    shutdownTimeoutMs: 30_000,
    pidFilePath: join(runtimeDir, 'loop.pid'),
    statusFilePath: join(runtimeDir, 'loop-status.json'),
  });

  console.log(`Codex E2E backlog: ${initial.webUrl ?? backlogId}`);
  console.log(`Codex runtime: transport=${runtime.transport} auth=${runtime.auth} provider=${runtime.provider}`);

  try {
    const loop = runner.start();
    const final = await waitForTerminal(providers.backlog, backlogId, loop, E2E_PHASE_TIMEOUT_MS);
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
    await assertRemoteFixture(change.sourceBranch, fixturePath, fixtureContent, workflow.targetBranch);
    console.log(`Codex E2E merge request: ${change.url}`);
    console.log(`Codex E2E passed: backlog=${backlogId} state=merge_ready mode=hitl`);
  } catch (error) {
    await runner.stop().catch(() => {});
    const current = await providers.backlog.get(backlogId).catch(() => undefined);
    console.error(`Codex E2E failed: backlog=${initial.webUrl ?? backlogId} state=${current?.state ?? 'unknown'} mode=${current?.executionMode ?? 'unknown'}`);
    throw error;
  } finally {
    await rm(manifestPath, { force: true });
    await rm(runtimeDir, { recursive: true, force: true });
    await cleanupRemoteArtifacts({
      tracker,
      backlogId,
      title,
      branches: [workingBranch, `${workingBranch}-qa`],
    });
  }
}

/**
 * Remove the remote artifacts a Codex E2E run creates on the real tracker:
 * the merge request, the issue, and the pushed branches. The local checkout
 * is restored by the multi-repository preparer, but nothing cleaned the
 * provider side, so every run used to leave an open issue, an open PR and
 * two remote branches behind on the user's repository.
 *
 * Set `AFK_CODEX_E2E_KEEP=1` to retain the artifacts for inspection.
 */
async function cleanupRemoteArtifacts(input: {
  tracker: TrackerProvider;
  backlogId: string;
  title: string;
  branches: readonly string[];
}): Promise<void> {
  if (process.env.AFK_CODEX_E2E_KEEP === '1') {
    console.log('Codex E2E cleanup skipped: AFK_CODEX_E2E_KEEP=1 retains the remote artifacts');
    return;
  }

  const { tracker, backlogId, title, branches } = input;
  const failures: string[] = [];

  try {
    const change = (await tracker.listMRs({ state: 'opened', perPage: 100 }))
      .find(candidate => candidate.title === `Backlog ${backlogId}: ${title}`);
    if (change) {
      await tracker.closeMR(change.id, { comment: 'Closed by the AFK Codex E2E cleanup.' });
    }
  } catch (error) {
    failures.push(`close merge request: ${errorMessage(error)}`);
  }

  try {
    await tracker.updateIssue(Number(backlogId), { state: 'closed' });
  } catch (error) {
    failures.push(`close issue: ${errorMessage(error)}`);
  }

  const git = simpleGit(process.cwd());
  for (const branch of branches) {
    try {
      await git.raw(['push', 'origin', '--delete', branch]);
    } catch (error) {
      const message = errorMessage(error);
      if (!/remote ref does not exist|couldn't find remote ref|does not exist/i.test(message)) {
        failures.push(`delete branch ${branch}: ${message}`);
      }
    }
  }

  if (failures.length > 0) {
    console.error(`Codex E2E cleanup incomplete:\n  ${failures.join('\n  ')}`);
    console.error('Remove the leftover artifacts on the tracker manually.');
  } else {
    console.log('Codex E2E cleanup: closed the merge request and issue, deleted the remote branches');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  targetBranch: string,
): Promise<void> {
  const git = simpleGit(process.cwd());
  await git.raw(['fetch', 'origin', sourceBranch, targetBranch]);
  const changedPaths = (await git.diff(['--name-only', `origin/${targetBranch}...origin/${sourceBranch}`])).trim().split('\n');
  assert.deepEqual(changedPaths, [fixturePath], 'merge request must change only the requested fixture');
  const remoteContent = await git.show([`origin/${sourceBranch}:${fixturePath}`]);
  assert.equal(remoteContent, `${fixtureContent}\n`, 'merge request source branch has unexpected fixture content');
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('AFK_CODEX_E2E_TIMEOUT_MS must be a positive integer');
  return parsed;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
