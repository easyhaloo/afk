import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [fixture, receipt, runId, runtime] = process.argv.slice(2);
const { WorkflowRunner } = await import(pathToFileURL(join(runtime, 'application/workflow-engine.js')));
const { createDefaultPluginRuntime, PluginManager } = await import(pathToFileURL(join(runtime, 'plugin-sdk/index.js')));
const { query } = JSON.parse(await readFile(join(fixture, 'historical.json')));
const workspace = process.cwd();
const workItemId = `${query.scope}#42`;
const branchName = 'feat/parcel-handoff';
const item = { id: '42', issueNumber: 42, workItemId, providerRef: workItemId, title: query.prompt, description: query.prompt,
  kind: 'task', state: 'ready', executionMode: 'afk', branchName, dependsOn: [], tags: [] };
const git = (...args) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
git('init', '-b', 'main');
git('-c', 'user.name=W11', '-c', 'user.email=w11@example.invalid', 'commit', '--allow-empty', '-m', 'Parcel work item');
const input = { manifest: ['B-147', 'B-302'], scanned: ['B-302', 'B-659'] };
await writeFile(join(workspace, '交接单.json'), JSON.stringify(input));
const oracle = { missing: input.manifest.filter(bag => !input.scanned.includes(bag)), extra: input.scanned.filter(bag => !input.manifest.includes(bag)) };
const templates = join(workspace, '.afk/workflows');
await mkdir(templates, { recursive: true });
const template = join(templates, 'handoff.yml');
await writeFile(template, `name: parcel-handoff
version: 1
steps:
  - id: implement
    kind: agent
    role: implementer
    prompt: ${JSON.stringify(query.prompt)}
  - id: queue
    kind: system
    action: queue-qa
    dependsOn: [implement]
`);
await new PluginManager({ homeDir: process.env.HOME }).configure('learning.distiller', { enabled: true, dailyCalls: 0,
  executionContexts: [{ applicability: query.applicability, target: query.target }] }, true);
const plugins = await createDefaultPluginRuntime({ homeDir: process.env.HOME, workspaceRoot: workspace });
const events = [];
const runner = new WorkflowRunner({
  backlog: { get: async () => item, claim: async () => ({ item, release: async () => {}, heartbeat: async () => {} }),
    getActiveRework: async () => null, transition: async (_id, state) => { item.state = state; },
    setExecutionMode: async (_id, mode) => { item.executionMode = mode; }, addComment: async () => {} },
  branches: { createBranch: async () => { git('checkout', '-b', branchName); return { branchName, worktreePath: workspace }; }, cleanup: async () => {} },
  changes: { findForBacklog: async () => null },
}, { plugins,
  observer: { record: async (_context, event) => { events.push(event); } } });
const result = await runner.run({ backlogId: item.id, workItemId, session: runId, observationRunId: runId,
  observationWorkItemId: workItemId, targetBranch: branchName, baseBranch: 'main', baseBranchExplicit: true,
  repoRoot: workspace, workspaceRoot: workspace, template, agentProvider: 'opencode', sandboxProvider: 'local',
  executionMode: 'batch', completionTimeoutMs: 90_000, hardTimeoutMs: 110_000, maxHandoffs: 1, maxRetries: 0 })
  .catch(error => ({ success: false, error: error.message }));
await plugins.dispose();
await writeFile(join(receipt, 'workflow.json'), JSON.stringify({ workItemId, runId, workspace, input, oracle, result, events }, null, 2));
const host = (...args) => JSON.parse(execFileSync('opencode', ['session', ...args, '--standalone'], { encoding: 'utf8', timeout: 15_000 }));
const session = events.find(event => event.kind === 'agent.session_recorded')?.sessionId ?? host('list', '--format', 'json')[0]?.id;
assert.ok(session, 'No native session for this isolated workspace');
const exported = host('export', session);
await writeFile(join(receipt, 'session.json'), JSON.stringify(exported, null, 2));
assert.equal(exported.info.id, session);
assert.equal(exported.info.location.directory, workspace);
