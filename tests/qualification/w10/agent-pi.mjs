import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { startLoopback } from './agent-pi-loopback.mjs';

const [release, scenario, mode] = process.argv.slice(2);
const load = name => import(join(release, 'node_modules/@afk/runtime/dist', `${name}.js`));
const { WorkflowRunner } = await load('application/workflow-engine');
const { createDefaultPluginRuntime } = await load('plugin-sdk/index');
const { createRunObserver } = await load('infrastructure/observability/run-observer-factory');
const workspace = process.cwd(), root = dirname(workspace);
const branchName = 'feat/pi-acceptance', workItemId = 'github:fixture/pi#1', runId = randomUUID();
const git = (...args) => execFileSync('git', args, { stdio: 'ignore' });
const cancel = scenario === 'cancel';
const goal = cancel ? 'Use bash to execute sh probe.sh and wait for it to finish.' :
  'Read input.json. Write the sum of its integers as a decimal integer to total.txt.';
const item = { id: '1', issueNumber: 1, workItemId, providerRef: workItemId, title: goal, description: goal,
  kind: 'task', state: 'ready', executionMode: 'afk', branchName, dependsOn: [], tags: [] };
let queued = false;
const providers = {
  backlog: { get: async () => item, claim: async () => ({ item, release: async () => {}, heartbeat: async () => {} }),
    getActiveRework: async () => null, setExecutionMode: async () => {}, addComment: async () => {},
    transition: async (_id, state) => { item.state = state; queued ||= state === 'verification'; } },
  branches: { createBranch: async () => { git('checkout', '-b', branchName); return { branchName, worktreePath: workspace }; }, cleanup: async () => {} },
  changes: { findForBacklog: async () => null },
};

function checkSession(event, receipt) {
  const sessions = join(process.env.PI_CODING_AGENT_DIR, 'sessions');
  const files = readdirSync(sessions, { recursive: true }).filter(name => name.endsWith('.jsonl'));
  assert.equal(files.length, 1);
  const [header, ...entries] = readFileSync(join(sessions, files[0]), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  receipt.sessionMatches = header.type === 'session' && /^[\da-f-]{36}$/i.test(header.id) && header.id === event?.sessionId && header.cwd === workspace;
  const turns = entries.map(entry => entry.message).filter(message => message?.role === 'assistant');
  receipt.assistantTurns = turns.length;
  receipt.nativeUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const settings = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, 'settings.json')));
  for (const { usage, model, provider } of turns) {
    assert.equal(model, settings.defaultModel);
    assert.equal(provider, settings.defaultProvider);
    receipt.nativeUsage.inputTokens += usage.input + usage.cacheRead + usage.cacheWrite;
    receipt.nativeUsage.outputTokens += usage.output;
    receipt.nativeUsage.totalTokens += usage.totalTokens;
  }
  receipt.productUsage = Object.fromEntries(Object.keys(receipt.nativeUsage).map(key => [key, event?.usage?.[key]]));
  assert.ok(receipt.sessionMatches && turns.length && receipt.nativeUsage.outputTokens > 0 && receipt.nativeUsage.inputTokens > 0);
  assert.deepEqual(receipt.productUsage, receipt.nativeUsage);
}

const receipt = { passed: false, phase: 'setup' };
const events = [], controller = new AbortController(), reason = new Error('W10 operator cancellation');
let plugins, poll, nativePid, server;
try {
  if (mode === 'isolated-loopback-fixture') server = await startLoopback(cancel);
  git('init', '-b', 'main');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'synthetic');
  const inputs = [randomInt(1000, 9000), 13, 27];
  writeFileSync('input.json', JSON.stringify(inputs));
  writeFileSync('probe.sh', 'echo $$ > started.pid\nsleep 8\ntouch late\n');
  const template = join(root, 'flow.yml');
  writeFileSync(template, `name: pi-qualification\nversion: 1\nsteps:\n  - id: implement\n    kind: agent\n    role: implementer\n    prompt: |-\n      ${goal} Finish with <goal_complete>{"type":"goal_complete","kind":"task","summary":"done"}</goal_complete>.\n  - id: queue\n    kind: system\n    action: queue-qa\n    dependsOn: [implement]\n`);
  plugins = await createDefaultPluginRuntime({ homeDir: process.env.HOME, workspaceRoot: workspace });
  const observer = createRunObserver(process.env.AFK_EVENT_STORE_DIR, [], { onPersisted: async ({ context, data }) => {
    if (context.runId === runId && context.workItemId === workItemId) events.push(data);
  } });
  const runner = new WorkflowRunner(providers, { plugins, observer });
  if (cancel) poll = setInterval(() => {
    if (controller.signal.aborted || !existsSync('started.pid')) return;
    let pid = Number(readFileSync('started.pid', 'utf8'));
    while (pid > 1) {
      const parent = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)]).toString().trim());
      if (parent === process.pid) { nativePid = pid; break; }
      pid = parent;
    }
    controller.abort(reason);
  }, 50);
  receipt.phase = 'workflow';
  const result = await runner.run({ backlogId: '1', workItemId, session: runId, observationWorkItemId: workItemId,
    observationRunId: runId, targetBranch: branchName, baseBranch: 'main', baseBranchExplicit: true, repoRoot: workspace,
    workspaceRoot: workspace, template, agentProvider: 'pi', sandboxProvider: 'local', executionMode: 'batch',
    completionTimeoutMs: 65000, hardTimeoutMs: 90000, maxRetries: 0, maxHandoffs: 1, signal: controller.signal,
  }).catch(error => { if (error !== reason) throw error; return { success: false }; });
  const finished = events.findLast(event => event.kind === 'run.finished');
  Object.assign(receipt, { workflowSuccess: result.success, state: item.state, queued,
    terminal: finished?.outcome, reasonCode: finished?.reasonCode,
    failureCodes: events.filter(event => event.kind === 'failure.classified').map(event => event.code) });
  if (cancel) {
    receipt.phase = 'cancellation';
    receipt.abortAfterStart = controller.signal.reason === reason && Boolean(nativePid);
    await delay(9000);
    receipt.delayedWrite = existsSync('late');
    receipt.processExited = false;
    if (nativePid) {
      try { process.kill(nativePid, 0); } catch (error) { receipt.processExited = error.code === 'ESRCH'; }
    }
    assert.ok(receipt.abortAfterStart && receipt.processExited && !receipt.delayedWrite);
    assert.ok(!result.success && !queued && item.state === 'blocked');
    assert.equal(receipt.terminal, 'cancelled');
  } else {
    receipt.phase = 'artifact';
    receipt.expected = inputs.reduce((sum, value) => sum + value, 0);
    receipt.artifactMatches = existsSync('total.txt') && readFileSync('total.txt', 'utf8').trim() === String(receipt.expected);
    assert.ok(receipt.artifactMatches && result.success && queued && item.state === 'verification');
    receipt.implementationCompleted = events.some(event => event.kind === 'implementation.completed');
    assert.ok(receipt.implementationCompleted);
    receipt.phase = 'native-session-usage';
    checkSession(events.find(event => event.kind === 'agent.session_recorded'), receipt);
  }
  Object.assign(receipt, { phase: 'complete', passed: true });
} catch (error) {
  const sessions = join(process.env.PI_CODING_AGENT_DIR, 'sessions');
  const files = existsSync(sessions) ? readdirSync(sessions, { recursive: true }).filter(name => name.endsWith('.jsonl')) : [];
  receipt.nativeSessionFiles = files.length;
  const errors = files.flatMap(file => readFileSync(join(sessions, file), 'utf8').trim().split('\n').map(line => JSON.parse(line).message?.errorMessage ?? ''));
  receipt.nativeErrorMarkers = ['400', '401', '402', '403', '404', '429', '500', '502', '503', 'auth', 'connect', 'timeout', 'quota'].filter(term => errors.some(text => text.toLowerCase().includes(term)));
  receipt.failureCodes = events.filter(event => event.kind === 'failure.classified').map(event => event.code);
  process.exitCode = 1;
} finally {
  clearInterval(poll);
  await plugins?.dispose();
  server?.close();
  writeFileSync(join(root, 'result.json'), JSON.stringify(receipt), { flag: 'wx' });
}
