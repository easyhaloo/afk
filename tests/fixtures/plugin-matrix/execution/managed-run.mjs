import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const runtime = path => import(pathToFileURL(join(process.env.MATRIX_RUNTIME, path + '.js')).href);
const { createDefaultPluginRuntime, createPluginRunObserver } = await runtime('plugin-sdk/index');
const { WorkflowRunner } = await runtime('application/workflow-engine');
const [agent, sandbox, mode] = process.argv.slice(2);
const workspace = process.cwd();
const plugins = await createDefaultPluginRuntime({ homeDir: process.env.HOME, workspaceRoot: workspace });
const events = [];
const audit = process.env.MATRIX_PERSIST_AUDIT === '1' ? createPluginRunObserver(plugins) : undefined;
const transitions = [];
let released = 0;
let cleaned = 0;
const item = {
  id: '42', workItemId: process.env.MATRIX_WORK_ITEM_ID ?? 'github:matrix/repo#42', issueNumber: 42,
  providerRef: process.env.MATRIX_WORK_ITEM_ID ?? 'github:matrix/repo#42', title: process.env.MATRIX_WORK_TITLE ?? 'Simulated agent matrix', description: 'Run the deterministic subprocess fixture.',
  kind: 'task', state: 'ready', executionMode: 'afk', branchName: 'feat/matrix', dependsOn: [], tags: [],
};
const providers = {
  backlog: {
    get: async () => item,
    claim: async () => ({ item, release: async () => { released++; }, heartbeat: async () => {} }),
    getActiveRework: async () => null,
    transition: async (_id, state) => { transitions.push(state); item.state = state; },
    setExecutionMode: async (_id, value) => { item.executionMode = value; },
    addComment: async () => {},
  },
  branches: {
    createBranch: async () => {
      execFileSync('git', ['checkout', '-b', 'feat/matrix'], { cwd: workspace, stdio: 'pipe' });
      return { branchName: 'feat/matrix', worktreePath: workspace };
    },
    cleanup: async () => { cleaned++; },
  },
  changes: { findForBacklog: async () => null },
};
let armed = false;
let outcome;
try {
  const runner = new WorkflowRunner(providers, {
    plugins, observer: { record: async (context, event) => {
      events.push(event);
      return audit?.record(context, event);
    } },
    prepareRuntime: async selection => selection,
    watchdog: { arm() { armed = true; }, disarm() { armed = false; } },
    tmux: { killSession: async () => {}, closeSession: async () => {}, capturePane: async () => '' },
  });
  const result = await runner.run({
    backlogId: item.id, workItemId: item.workItemId, session: 'matrix-42',
    observationRunId: process.env.MATRIX_RUN_ID ?? 'matrix-42', observationWorkItemId: item.workItemId,
    targetBranch: 'feat/matrix', baseBranch: 'main', baseBranchExplicit: true,
    repoRoot: workspace, workspaceRoot: workspace, template: join(workspace, '.afk', 'workflows', 'matrix.yml'),
    agentProvider: agent, sandboxProvider: sandbox, executionMode: 'batch',
    completionTimeoutMs: mode === 'hang' ? 1500 : 5000, hardTimeoutMs: 10000,
    maxHandoffs: 1,
  });
  outcome = { result };
} catch (error) {
  outcome = { error: error.message };
} finally {
  await plugins.dispose();
}
let effect;
try { effect = JSON.parse(await readFile(join(workspace, 'matrix-agent.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await writeFile(join(workspace, 'managed-result.json'), JSON.stringify({ ...outcome, events, transitions, released, cleaned, armed, effect }));
