import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [runtimeRoot, id, expectedRecords] = process.argv.slice(2);
const runtime = name => import(pathToFileURL(join(runtimeRoot, `${name}.js`)).href);
const workspace = process.cwd();
const checkout = join(workspace, '..', 'source');
const records = JSON.parse(expectedRecords);
const contextFile = join(workspace, '.afk', 'plugin-context.md');
const workItemId = `github:qualification/code-context#${id}`;
const runId = `code-context-${randomUUID()}`;
const branchName = `feat/code-context-${id}`;
const item = { id, issueNumber: Number(id), workItemId, providerRef: workItemId,
  title: 'Read the widget context', description: 'Read the widget context', kind: 'task', state: 'ready',
  executionMode: 'afk', branchName, dependsOn: [], tags: [] };
const git = (...args) => execFileSync('git', args, { cwd: checkout, stdio: 'pipe' });
const template = join(workspace, '..', `workflow-${id}.yml`);
await writeFile(template, `name: code-context-consumer
version: 1
steps:
  - id: implement
    kind: agent
    role: implementer
    prompt: Read the widget context.
  - id: queue
    kind: system
    action: queue-qa
    dependsOn: [implement]
`);
const { createDefaultPluginRuntime } = await runtime('plugin-sdk/index');
const { WorkflowRunner } = await runtime('application/workflow-engine');
const plugins = await createDefaultPluginRuntime({ workspaceRoot: checkout });
const finished = [];
let dispatches = 0;
let contextSha256;
try {
  const runner = new WorkflowRunner({
    backlog: { get: async () => item, claim: async () => ({ item, release: async () => {}, heartbeat: async () => {} }),
      getActiveRework: async () => null, transition: async (_id, state) => { item.state = state; },
      setExecutionMode: async (_id, mode) => { item.executionMode = mode; }, addComment: async () => {} },
    branches: { createBranch: async () => {
      git('worktree', 'add', '-b', branchName, workspace, 'main');
      await writeFile(join(workspace, 'widget.ts'), `export const widget = "execution-${id}";`);
      return { branchName, worktreePath: workspace };
    }, cleanup: async () => {} },
    changes: { findForBacklog: async () => null },
  }, {
    plugins,
    observer: { record: async (_context, event) => { if (event.kind === 'run.finished') finished.push(event); } },
    agentProvider: { name: 'claude-code', capabilities: new Set(), async createExecution({ sessionId, worktreePath, prompt }) {
      dispatches++;
      assert.equal(worktreePath, workspace);
      assert.match(prompt, /Additional reference context is in \.afk\/plugin-context\.md/);
      const bytes = await readFile(contextFile, 'utf8');
      for (const { origin, content } of records) {
        assert(bytes.includes(`\nSource: ${origin}\n\n${content}\n`), `Missing fragment ${origin}`);
        assert(!prompt.includes(content));
      }
      assert.equal((bytes.match(/^Source: /gm) ?? []).length, records.length);
      contextSha256 = createHash('sha256').update(bytes).digest('hex');
      return { id: sessionId, metadata: { provider: 'claude-code', transport: 'process' }, kill: async () => {},
        waitForResult: async () => ({ version: 1, runId: sessionId, status: 'completed', provider: 'fixture', commits: [],
          structuredOutput: { type: 'goal_complete', kind: 'task', summary: 'code reference observed' } }) };
    } },
  });
  const run = runner.run({ backlogId: id, workItemId, session: runId, observationRunId: runId,
    observationWorkItemId: workItemId, targetBranch: branchName, baseBranch: 'main', baseBranchExplicit: true,
    repoRoot: checkout, workspaceRoot: checkout, template, agentProvider: 'claude-code', sandboxProvider: 'local',
    executionMode: 'batch', completionTimeoutMs: 5000, hardTimeoutMs: 10000, maxHandoffs: 1, maxRetries: 0 });
  let diagnostic;
  if (records.length) {
    const result = await run;
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(dispatches, 1);
    assert.match(contextSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(finished.map(event => event.outcome), ['succeeded']);
  } else {
    await assert.rejects(run, error => {
      diagnostic = error.message;
      return diagnostic === 'Capability provider is not registered';
    });
    assert.equal(dispatches, 0);
    assert.deepEqual(finished.map(event => event.outcome), ['failed']);
  }
  await assert.rejects(readFile(join(checkout, '.afk', 'plugin-context.md')), { code: 'ENOENT' });
  await assert.rejects(readFile(contextFile), { code: 'ENOENT' });
  assert.match(git('worktree', 'list', '--porcelain').toString(), new RegExp(`worktree .*run-${id}`));
  git('worktree', 'remove', '--force', workspace);
  console.log(JSON.stringify({ runId, workItemId, dispatches, matchedRecords: records.length, contextSha256,
    cleanup: true, outcome: finished[0]?.outcome, diagnostic }));
} finally {
  await plugins.dispose();
}
