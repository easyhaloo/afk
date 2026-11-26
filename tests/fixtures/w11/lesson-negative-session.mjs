import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [mode, evidence, id, out] = process.argv.slice(2);
assert.match(id, /^lesson-0[3-6]$/);
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (name, value) => writeFileSync(join(out, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const query = read(join(evidence, id, 'observed.input.json'));
const installed = read(join(evidence, 'source/installed.json'));
const workspace = process.cwd();
if (mode === 'run') {
  const runtime = join(dirname(dirname(installed.binary)), 'node_modules/@afk/runtime/dist');
  const { WorkflowRunner } = await import(join(runtime, 'application/workflow-engine.js'));
  const { createDefaultPluginRuntime } = await import(join(runtime, 'plugin-sdk/index.js'));
  const git = (...args) => execFileSync('git', args, { stdio: 'pipe' });
  git('init', '-b', 'main');
  git('-c', 'user.name=W11', '-c', 'user.email=w11@example.invalid', 'commit', '--allow-empty', '-m', 'Consumer baseline');
  const template = join(workspace, '.afk/workflows/answer.yml');
  mkdirSync(dirname(template), { recursive: true });
  const task = `/goal ${query.prompt}\n请检查 ${workspace}/.afk/experience-context.md。只使用该文件作为资料，把其中适用的修复方法和 Source 原文写到 ${workspace}/answer.json，字段为 fix、source。文件不存在或无适用资料时均填 null。写好即结束。`;
  writeFileSync(template, `name: lesson-consumer\nversion: 1\nsteps:\n  - id: implement\n    kind: agent\n    role: implementer\n    prompt: ${JSON.stringify(task)}\n  - id: queue\n    kind: system\n    action: queue-qa\n    dependsOn: [implement]\n`);
  const number = 720 + Number(id.slice(-2));
  const workItemId = `${query.scope}#${number}`;
  const runId = `lesson-consumer-${randomUUID()}`;
  const branchName = 'feat/lesson-consumer';
  const item = { id: String(number), issueNumber: number, workItemId, providerRef: workItemId, title: query.prompt, description: query.prompt, kind: 'task', state: 'ready', executionMode: 'afk', branchName, tags: [], dependsOn: [] };
  const plugins = await createDefaultPluginRuntime({ homeDir: process.env.HOME, workspaceRoot: workspace });
  const provider = plugins.getContextProvider('context.experience');
  const gather = provider.gatherForRun.bind(provider);
  const calls = [];
  provider.gatherForRun = (actual, source) => {
    const fragments = gather(actual, source);
    calls.push({ query: actual, source, origins: fragments.map(row => row.fragment.origin) });
    return fragments;
  };
  const events = [];
  try {
    const runner = new WorkflowRunner({ backlog: { get: async () => item, claim: async () => ({ item, release: async () => {}, heartbeat: async () => {} }),
      getActiveRework: async () => null, transition: async (_id, state) => { item.state = state; }, setExecutionMode: async () => {}, addComment: async () => {} },
    branches: { createBranch: async () => { git('checkout', '-b', branchName); return { branchName, worktreePath: workspace }; }, cleanup: async () => {} },
    changes: { findForBacklog: async () => null } }, { plugins, experienceContext: { applicability: query.applicability, target: query.target },
      observer: { record: async (_context, event) => { events.push(event); } } });
    const result = await runner.run({ backlogId: item.id, workItemId, session: runId, observationWorkItemId: workItemId, observationRunId: runId,
      targetBranch: branchName, baseBranch: 'main', baseBranchExplicit: true, repoRoot: workspace, workspaceRoot: workspace, template,
      agentProvider: 'opencode', sandboxProvider: 'local', executionMode: 'batch', completionTimeoutMs: 120000, hardTimeoutMs: 150000, maxRetries: 0, maxHandoffs: 1 });
    save('workflow.json', { id, workspace, runId, workItemId, result, events, calls, contextFile: existsSync(join(workspace, '.afk/experience-context.md')) });
    const session = events.find(event => event.kind === 'agent.session_recorded')?.sessionId;
    assert.match(session, /^ses_/);
    save('session.json', JSON.parse(execFileSync('opencode', ['session', 'export', session, '--standalone'], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 })));
    save('answer.json', read(join(workspace, 'answer.json')));
  } finally { await plugins.dispose(); }
} else assert.equal(mode, 'replay');

const workflow = read(join(out, 'workflow.json'));
const session = read(join(out, 'session.json'));
const answer = read(join(out, 'answer.json'));
assert.equal(workflow.id, id);
assert.equal(workflow.result.success, true);
assert.equal(workflow.calls.length, 1);
const [call] = workflow.calls;
assert.deepEqual(call.source, { runId: workflow.runId, workItemId: workflow.workItemId });
assert.ok(call.query.prompt.includes(query.prompt));
const { revision, dirty, ...target } = call.query.target;
assert.match(revision, /^[a-f0-9]{40}$/);
assert.equal(typeof dirty, 'boolean');
assert.deepEqual(target, query.target);
assert.equal(call.query.scope, query.scope);
assert.equal(call.query.limit, query.limit);
assert.equal(call.query.applicability.environment, query.applicability.environment);
if (call.query.applicability.version) assert.equal(call.query.applicability.version, query.target.productVersions.parcel);
assert.deepEqual(call.origins, []);
assert.equal(workflow.contextFile, false);
assert.ok(!workflow.events.some(event => event.command === 'experience.recall' && event.accepted));
assert.equal(workflow.events.find(event => event.kind === 'agent.session_recorded')?.sessionId, session.info.id);
assert.equal(session.info.location.directory, workflow.workspace);
assert.ok(session.messages.some(message => message.type === 'user' && message.text.includes(query.prompt)));
assert.ok(session.messages.some(message => message.type === 'assistant' && message.finish === 'stop'));
assert.equal(session.messages.at(-1).outcome, 'succeeded');
const tools = session.messages.filter(message => message.type === 'assistant').flatMap(message => message.content).filter(part => part.type === 'tool');
const contextPath = join(workflow.workspace, '.afk/experience-context.md');
assert.ok(tools.some(tool => tool.name === 'read' && tool.state.input.path === contextPath && tool.state.status === 'error' && tool.state.error.message.includes('File not found')));
const write = tools.find(tool => tool.name === 'write' && tool.state.status === 'completed' && tool.state.input.path === join(workflow.workspace, 'answer.json'));
assert.deepEqual(JSON.parse(write.state.input.content), answer);
const [lesson] = read(join(evidence, 'source/verified.json'));
for (const withheld of [lesson.action, lesson.publication.key, lesson.publication.targetRef, 'experience:' + lesson.id, 'verification:run:' + lesson.verifiedEvidence.runId]) {
  assert.ok(!JSON.stringify(session.messages).includes(withheld), 'Withheld lesson found in native session');
}
assert.deepEqual(answer, { fix: null, source: null });
console.log(JSON.stringify({ id, workItemId: workflow.workItemId, runId: workflow.runId, session: session.info.id, messages: session.messages.length, origins: call.origins, answer }));
