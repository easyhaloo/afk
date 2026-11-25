import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { applicability, initialize, observe, perform } from './process-01-counter.mjs';
import { gradeProcess, publicationReceipt } from './process-01-consumer.mjs';

const [mode, entry, question, parent, caseId = 'process-01'] = process.argv.slice(2);
const issueNumber = { 'process-01': 52, 'process-02': 53, 'process-03': 54, 'process-04': 55, 'process-05': 56, 'process-06': 57 }[caseId];
assert.ok(issueNumber);
const pickup = caseId === 'process-03';
const crossProject = caseId === 'process-04';
const revokeAccess = caseId === 'process-05';
const withdraw = caseId === 'process-06';
const excluded = pickup || crossProject || revokeAccess || withdraw;
assert.ok(isAbsolute(entry), 'Provide an absolute installed AFK CLI entry');
const binary = realpathSync(entry);
const release = dirname(dirname(binary));
const runtime = realpathSync(join(release, 'node_modules/@afk/runtime/dist'));
assert.equal(binary, join(release, 'dist/index.js'));
assert.ok(runtime.startsWith(`${release}/`));
const load = name => import(pathToFileURL(join(runtime, `${name}.js`)).href);
const publicReview = mode === 'review';
const home = mode === 'run' || publicReview ? realpathSync(mkdtempSync(join(parent || tmpdir(), 'w11-process-01-')))
  : mode === 'audit' ? realpathSync(question) : mode === 'managed' ? realpathSync(process.env.HOME) : process.cwd();
const userHome = process.env.AFK_REAL_DISTILLATION_HOME || userInfo().homedir;
const scope = 'github:w11/parcel';
const consumerScope = crossProject ? 'github:w11/parcel-archive' : scope;
const targetRef = 'wiki:return-handoff';
const meta = { scope, checkerId: 'return-handoff', providerId: 'parcel-register', version: '1' };
const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH, NO_COLOR: '1', AFK_EVENT_STORE_DIR: join(home, 'events') };
const nativeEnv = { ...env, HOME: userHome, XDG_CONFIG_HOME: join(userHome, '.config'), XDG_DATA_HOME: join(userHome, '.local/share'),
  AFK_OPENCODE_MODEL: process.env.AFK_OPENCODE_MODEL, OPENCODE_CONFIG: process.env.OPENCODE_CONFIG };
const directory = join(home, '.afk/learning');
const desk = join(home, 'desk');
const database = join(desk, 'returns.sqlite');
const script = fileURLToPath(import.meta.url);
const counter = new URL('./process-01-counter.mjs', import.meta.url);
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const output = mode === 'managed' ? dirname(process.cwd()) : home;
const save = (name, value) => { const path = join(output, name); writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 }); return path; };
const command = (program, args, options = {}) => execFileSync(program, args, { cwd: home, env, encoding: 'utf8', timeout: 25_000,
  maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options });
const cli = (...args) => command(process.execPath, [binary, ...args]);
const invoke = (...args) => JSON.parse(cli(...args, '--json'));
const hash = value => createHash('sha256').update(value).digest('hex');

async function businessSession() {
  mkdirSync(desk);
  const bag = `R-${randomUUID().slice(0, 8)}`;
  initialize(database, bag);
  assert.throws(() => perform(database, `${bag}-pickup`, '核对袋号'));
  assert.throws(() => perform(database, bag, '登记签收'));
  assert.equal(observe(database, bag).steps.length, 0);
  copyFileSync(counter, join(desk, 'counter.mjs'));
  const prompt = `收到退件 ${bag}，非自提。请现在通过 shell 一次执行以下柜台命令完成退件交接，无需查看文件：node counter.mjs 核对袋号 ${bag} && node counter.mjs 登记签收 ${bag}。根据两个返回值告知办理结果。`;
  const run = command('opencode', ['run', '--format', 'json', ...(nativeEnv.AFK_OPENCODE_MODEL ? ['-m', nativeEnv.AFK_OPENCODE_MODEL] : []), prompt],
    { cwd: desk, env: nativeEnv, timeout: 140_000 });
  const sessionId = run.trim().split('\n').map(line => JSON.parse(line)).find(event => event.sessionID)?.sessionID;
  assert.match(sessionId, /^ses_/);
  const native = JSON.parse(command('opencode', ['session', 'export', sessionId, '--standalone'], { cwd: desk, env: nativeEnv }));
  assert.equal(native.info.id, sessionId);
  assert.ok(native.messages.some(message => message.type === 'user' && message.text.includes(bag)));
  const transcriptRoot = join(home, '.afk/transcripts');
  mkdirSync(transcriptRoot, { recursive: true });
  const transcript = save(`.afk/transcripts/${sessionId}.json`, native);
  assert.ok(native.messages.some(message => message.type === 'assistant' && message.content.some(part => part.type === 'tool' && ['shell', 'bash'].includes(part.name)
    && part.state.status === 'completed' && JSON.stringify(part.state.input).includes(`登记签收 ${bag}`))));
  const observed = observe(database, bag);
  assert.deepEqual(observed.steps.map(step => step.action), ['核对袋号', '登记签收']);
  assert.equal(observed.completion, '已签收');
  save('authority.json', { ...observed, applicability });
  const runId = `process-01-${randomUUID()}`;
  const workItemId = `${scope}#51`;
  const { JsonlEventStore } = await load('infrastructure/observability/jsonl-event-store');
  const events = new JsonlEventStore({ root: env.AFK_EVENT_STORE_DIR });
  const data = [{ kind: 'agent.session_recorded', sessionId, transcriptPath: transcript }, { kind: 'qa.started' },
    { kind: 'effect.completed', effectKind: 'parcel.return-handoff', idempotencyKey: bag, outcome: 'succeeded',
      summary: JSON.stringify({ register: '退件交接', page: targetRef, environment: 'staging', product: 'parcel', version: '2.0', pickup: false, applicability, ...observed }) },
    { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' }];
  await events.append(data.map(item => ({ id: randomUUID(), schemaVersion: 1, type: item.kind, occurredAt: new Date().toISOString(), correlationId: runId,
    context: { runId, workItemId, traceId: runId, profileId: 'parcel', attempt: 1, actor: { kind: 'system', id: 'register' } }, data: item })));
  const sources = [{ id: 'audit-1', kind: 'audit', runId, allowedRoot: events.root, path: events.pathFor(runId) },
    { id: 'session-1', kind: 'session', allowedRoot: transcriptRoot, path: transcript }];
  return { sessionId, bag, runId, workItemId, sources };
}

function configure(source, digest) {
  const vault = join(home, 'wiki');
  mkdirSync(vault);
  const rules = '# Process-01 test Wiki\n';
  writeFileSync(join(vault, 'AGENTS.md'), rules);
  for (const [name, title, body] of [['template', '{{title}}', '{{knowledge}}'], ['index', 'Index', '[[links]]'], ['links', 'Links', '[[index]]']]) {
    writeFileSync(join(vault, `${name}.md`), `---\ntags: [knowledge]\nlast_updated: 2026-11-18\n---\n# ${title}\n\n${body}\n`);
  }
  const grant = save('grant.json', { version: 1, revoked: false, allowWithdrawal: true, policy: { scope, vault,
    rules: { 'AGENTS.md': hash(rules), '.tools/wiki-lint.py': null }, targets: [{ ref: targetRef, paths: ['ReturnHandoff.md'], kinds: ['process'],
      snapshot: false, inbox: false, templatePath: 'template.md', indexPaths: ['index.md'], backlinkPaths: ['links.md'] }] } });
  const configurationFile = save('checkers.json', { version: 1, checkers: [{ ...meta, authorizationFile: grant,
    target: { root: home, path: 'authority.json', ref: targetRef }, evidence: [{ digest, sources: source.sources }] }] });
  const extension = join(home, 'checker');
  mkdirSync(extension);
  const manifest = { id: 'verification.return-handoff', version: '1.0.0', apiVersion: 1, entry: 'index.js', trusted: true, provides: ['verification.provider'] };
  save('checker/package.json', { name: 'return-handoff', version: '1.0.0', type: 'module' });
  save('checker/plugin.json', manifest);
  copyFileSync(counter, join(extension, 'counter.mjs'));
  writeFileSync(join(extension, 'index.js'), `import { checkAssertions } from './counter.mjs';
    import { writeFileSync } from 'node:fs';
    const identity = ${JSON.stringify(meta)};
    export default () => ({ manifest: ${JSON.stringify(manifest)}, activate(context) {
      context.registerVerificationProvider(identity.providerId, { id: identity.providerId,
        capabilities: { 'test-execution': true, 'static-analysis': false, 'custom-script': false },
        async doctor() { return [{ check: 'learning-validation-v1', ok: true, detail: JSON.stringify(identity) }]; },
        async verify(request) {
          const { binding, assertions } = JSON.parse(request.target);
          const results = checkAssertions(${JSON.stringify(database)}, ${JSON.stringify(source.bag)}, assertions);
          const report = { protocol: 'learning-validation-v1', binding, assertions: results };
          writeFileSync(${JSON.stringify(join(home, 'independent-check.json'))}, JSON.stringify(report, null, 2), { mode: 0o600 });
          return { passed: true, durationMs: 1, output: JSON.stringify(report) };
        } }); } });`);
  cli('plugin', 'install', extension);
  const sourceReadGrantFile = revokeAccess ? save('source-access.json', { version: 1, grants: [{ scope, targetRef, evidenceDigest: digest,
    paths: [...source.sources.map(item => item.path), join(home, 'authority.json')], revoked: false }] }) : undefined;
  cli('plugin', 'configure', 'learning.distiller', '--builtin', '--file', save('distiller.json', { enabled: true, dailyCalls: publicReview ? 1 : 0,
    executionContexts: [...new Set([scope, consumerScope])].map(project => ({ applicability: { environment: 'staging', version: '2.0' }, target: { project, productVersions: { parcel: '2.0' }, conditions: { pickup } } })),
    validation: { configurationFile }, knowledge: { wikiScript: fileURLToPath(new URL('../../../skills/wiki/scripts/wiki.py', import.meta.url)), grants: [grant], sourceReadGrantFile } }));
}

async function analyze() {
  const { LearningWorker, executeAnalysis, parseAnalysisOutput } = await load('execution');
  const { ClaudeCodeProvider } = await load('domain/agents/claude-code');
  const { request, snapshot, requestKey } = read(join(home, 'intake.json'));
  const worker = new LearningWorker({ directory, enabled: true, dailyCalls: 1, provider: new ClaudeCodeProvider(), analyze: async input => {
    const result = await executeAnalysis(input);
    try { parseAnalysisOutput(result.output, request, snapshot); }
    catch (error) { save('analysis-error.json', { message: error.message, issues: error.issues }); }
    return result;
  } });
  try { await worker.runOnce({ scope, requestKey }); } finally { await worker.close(); }
}

async function pipeline() {
  console.log(`process-01 evidence ${home}`);
  const version = cli('--version').trim();
  assert.equal(version, read(join(release, 'release.json')).version);
  const source = await businessSession();
  if (publicReview) return reviewProcess(source, version);
  const { reconcileDistillationSources } = await load('execution');
  const { CandidateStore } = await load('application/learning/candidate-store');
  const intake = await reconcileDistillationSources({ directory, eventRoot: env.AFK_EVENT_STORE_DIR, homeDir: home, scope, runId: source.runId, workItemId: source.workItemId });
  assert.deepEqual(intake.blocked, []);
  assert.equal(intake.submitted, 1);
  const [requestKey] = intake.requestKeys;
  const store = new CandidateStore({ file: join(directory, 'candidates.sqlite') });
  try {
    const { request } = store.getRequest(requestKey);
    const snapshot = store.getEvidencePack(request.evidenceDigest);
    store.close();
    save('intake.json', { version, binary, source, requestKey, request, snapshot });
    assert.equal(snapshot.completeness, 'complete');
    assert.ok(snapshot.entries.some(entry => entry.ref.kind === 'message' && JSON.parse(entry.content).role === 'assistant'));
    configure(source, snapshot.digest);
    command(process.execPath, [script, 'worker', binary], { timeout: 155_000, env: { ...env, HOME: userHome, USERPROFILE: userHome,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN } });
    const { queryLearningRequest } = await load('application/learning/worker');
    const { job, candidates } = queryLearningRequest({ directory, scope, requestKey });
    save('extraction.json', { job, candidates });
    assert.equal(job.status, 'processed', job.reasonCode);
    assert.equal(job.attempts.length, 1);
    const [attempt] = job.attempts;
    assert.ok(attempt.status === 'succeeded' && attempt.sessionId && attempt.usage?.totalTokens > 0);
    const processes = candidates.filter(candidate => candidate.proposal.kind === 'process');
    assert.equal(processes.length, 1, 'Expected one independently extracted process');
    const [candidate] = processes;
    assert.equal(candidate.evidenceDigest, snapshot.digest);
    let validation;
    try { validation = invoke('experience', 'validate', candidate.id, '--scope', scope, '--expected-version', '1', '--checker', meta.checkerId); }
    catch (error) {
      if (error.stdout?.trim().startsWith('{')) save('validation.json', JSON.parse(error.stdout));
      throw error;
    }
    save('validation.json', validation);
    assert.equal(validation.status, 'validated', JSON.stringify(validation));
    const prepared = invoke('experience', 'knowledge', 'prepare', candidate.id, '--scope', scope, '--expected-version', String(validation.validatedVersion));
    const { publication } = invoke('experience', 'knowledge', 'publish', prepared.key, '--scope', scope);
    save('publication.json', publication);
    assert.equal(publication.phase, 'committed');
    assert.equal(publication.evidenceDigest, snapshot.digest);
    assert.equal(publication.candidateId, candidate.id);
    assert.equal(publication.candidateVersion, 2);
    assert.equal(publication.targetRef, targetRef);
    assert.equal(publication.validatorVersion, `learning-validation-v1:${validation.executionId}`);
    assert.ok(readFileSync(join(home, 'wiki/ReturnHandoff.md'), 'utf8').includes(snapshot.digest));
    if (revokeAccess || withdraw) changePublicationAccess(publication, source, CandidateStore);
    save('consumer-run.json', launchConsumer(home));
  } finally { store.close(); }
}

async function reviewProcess(source, version) {
  const { buildEvidencePack } = await load('application/learning/evidence');
  const snapshot = await buildEvidencePack({ sources: source.sources });
  assert.equal(snapshot.completeness, 'complete');
  configure(source, snapshot.digest);
  assert.deepEqual(invoke('experience', 'jobs', '--scope', scope), []);
  const review = JSON.parse(command(process.execPath, [binary, 'experience', 'review', '--kind', 'success', '--run-id', source.runId,
    '--backlog-id', source.workItemId, '--checker', meta.checkerId, '--json'], { timeout: 155_000, env: { ...env,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || join(userHome, '.claude'), ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN } }));
  save('review.json', review);
  assert.equal(review.runId, source.runId);
  assert.equal(review.scope, scope);
  const { requestKey } = review;
  const { queryLearningRequest } = await load('application/learning/worker');
  const { job, candidates } = queryLearningRequest({ directory, scope, requestKey });
  save('intake.json', { version, binary, source, requestKey, snapshot });
  save('extraction.json', { job, candidates });
  assert.equal(job.status, 'processed');
  assert.equal(job.attempts.length, 1);
  assert.equal(review.prepared.length, 1);
  const [{ publication, candidateId, validatedVersion }] = review.prepared;
  assert.equal(publication.phase, 'prepared');
  assert.equal(publication.candidateId, candidateId);
  assert.equal(publication.evidenceDigest, snapshot.digest);
  assert.equal(validatedVersion, 2);
  assert.equal(existsSync(join(home, 'wiki/ReturnHandoff.md')), false);
  const published = invoke('experience', 'knowledge', 'publish', publication.key, '--scope', scope).publication;
  save('publication.json', published);
  assert.equal(published.phase, 'committed');
  assert.ok(readFileSync(join(home, 'wiki/ReturnHandoff.md'), 'utf8').includes(snapshot.digest));
  save('consumer-run.json', launchConsumer(home));
}

function changePublicationAccess(publication, source, CandidateStore) {
  const query = { scope, prompt: question, limit: 5, applicability: { environment: 'staging', version: '2.0' },
    target: { project: scope, productVersions: { parcel: '2.0' }, conditions: { pickup: false } } };
  const gather = () => invoke('plugin', 'invoke', 'context.provider', 'context.knowledge', 'gather', '--input', save('control-query.json', query));
  const origins = gather().map(fragment => fragment.origin);
  assert.deepEqual(origins, [`knowledge:${publication.key}; target:${targetRef}`]);
  save('before-change.json', { query, origins });
  const page = join(home, 'wiki/ReturnHandoff.md');
  if (revokeAccess) {
    const files = [page, ...source.sources.map(item => item.path), join(home, 'authority.json')];
    const digests = () => files.map(path => hash(readFileSync(path)));
    const before = digests();
    const access = read(join(home, 'source-access.json'));
    access.grants[0].revoked = true;
    save('source-access.json', access);
    assert.deepEqual(gather(), []);
    assert.deepEqual(digests(), before);
    const reader = new CandidateStore({ file: join(directory, 'candidates.sqlite') });
    try { assert.deepEqual(reader.getPublication(publication.key), publication); } finally { reader.close(); }
    save('revocation-check.json', { originsAfter: [], sourceAndPageDigests: before, phase: publication.phase });
  } else {
    const authority = read(join(home, 'authority.json'));
    save('authority.json', { ...authority, completion: '已停止交接' });
    const result = invoke('experience', 'knowledge', 'reconcile', '--scope', scope);
    assert.deepEqual(result.blocked, []);
    assert.equal(result.results.length, 1);
    const { withdrawal } = result.results[0];
    assert.equal(withdrawal.key, publication.key);
    assert.equal(withdrawal.candidateVersion, publication.candidateVersion);
    assert.equal(withdrawal.evidenceDigest, publication.evidenceDigest);
    assert.equal(withdrawal.status, 'withdrawn');
    assert.match(readFileSync(page, 'utf8'), /knowledge_status: revoked/);
    save('authority.json', authority);
    assert.deepEqual(gather(), []);
    save('withdrawal-check.json', withdrawal);
  }
}

function launchConsumer(fixture) {
  const evidence = realpathSync(mkdtempSync(join(dirname(fixture), `${caseId}-consumer-`)));
  const workspace = join(evidence, 'workspace');
  mkdirSync(workspace);
  console.error(`${caseId} consumer evidence ${evidence}`);
  command(process.execPath, [script, 'managed', binary, question, fixture, caseId], { cwd: workspace, timeout: 185_000,
    env: { ...nativeEnv, HOME: fixture, USERPROFILE: fixture, PWD: workspace, INIT_CWD: workspace, AFK_EVENT_STORE_DIR: join(fixture, 'events') } });
  return { evidence, ...read(join(evidence, 'verified.json')) };
}

async function consume() {
  const { CandidateStore } = await load('application/learning/candidate-store');
  const jobs = invoke('experience', 'jobs', '--scope', scope);
  const store = new CandidateStore({ file: join(directory, 'candidates.sqlite') });
  let receipt;
  try { receipt = publicationReceipt({ store, fixture: parent, binary, cliVersion: cli('--version').trim(), jobs, withdrawn: withdraw }); }
  finally { store.close(); }
  save('provenance.json', receipt);
  const { createDefaultPluginRuntime } = await load('plugin-sdk/index');
  const { WorkflowRunner } = await load('application/workflow-engine');
  const workspace = process.cwd();
  const git = (...args) => command('git', args, { cwd: workspace });
  git('init', '-b', 'main');
  git('-c', 'user.name=W11', '-c', 'user.email=w11@example.invalid', 'commit', '--allow-empty', '-m', 'Consumer baseline');
  const template = join(workspace, '.afk/workflows/process.yml');
  mkdirSync(dirname(template), { recursive: true });
  writeFileSync(template, `name: process-consumer\nversion: 1\nsteps:\n  - id: implement\n    kind: agent\n    role: implementer\n    prompt: |-\n      /goal ${question}\n      只读一次 ${join(workspace, '.afk/experience-context.md')}。据此将答复写入 ${join(workspace, 'answer.json')}。JSON 顶层仅含 steps、completion、source、productVersion 四个字段。steps 按顺序摘录各步的 action 和 stateChange，completion 填完成状态，source 复制 Source 行冒号后全部内容，productVersion 填适用版本。文件不存在就停止查找，无资料的字段填 null，包括 steps。\n  - id: queue\n    kind: system\n    action: queue-qa\n    dependsOn: [implement]\n`);
  const workItemId = `${consumerScope}#${issueNumber}`;
  const runId = `process-consumer-${randomUUID()}`;
  const branchName = 'feat/process-consumer';
  const item = { id: String(issueNumber), issueNumber, workItemId, providerRef: workItemId, title: question, description: question,
    kind: 'task', state: 'ready', executionMode: 'afk', branchName, dependsOn: [], tags: [] };
  const plugins = await createDefaultPluginRuntime({ homeDir: home, workspaceRoot: workspace });
  const events = [];
  const retrievals = [];
  try {
    const knowledge = plugins.getContextProvider('context.knowledge');
    const gather = knowledge.gather.bind(knowledge);
    knowledge.gather = async (query, ...options) => {
      const fragments = await gather(query, ...options);
      retrievals.push({ query, origins: fragments.map(fragment => fragment.origin) });
      return fragments;
    };
    const runner = new WorkflowRunner({ backlog: { get: async () => item, claim: async () => ({ item, release: async () => {}, heartbeat: async () => {} }),
      getActiveRework: async () => null, transition: async (_id, state) => { item.state = state; }, setExecutionMode: async () => {}, addComment: async () => {} },
      branches: { createBranch: async () => { git('checkout', '-b', branchName); return { branchName, worktreePath: workspace }; }, cleanup: async () => {} },
      changes: { findForBacklog: async () => null } }, { plugins, observer: { record: async (_context, event) => { events.push(event); } } });
    const result = await runner.run({ backlogId: item.id, workItemId, session: runId, observationWorkItemId: workItemId, observationRunId: runId, targetBranch: branchName,
      baseBranch: 'main', baseBranchExplicit: true, repoRoot: workspace, workspaceRoot: workspace, template, agentProvider: 'opencode', sandboxProvider: 'local',
      executionMode: 'batch', completionTimeoutMs: 120_000, hardTimeoutMs: 150_000, maxHandoffs: 1, maxRetries: 0 });
    save('consumer-run.json', { result, runId, workItemId, events, retrievals });
    assert.equal(result.success, true);
    const session = events.find(event => event.kind === 'agent.session_recorded')?.sessionId;
    assert.match(session, /^ses_/);
    assert.notEqual(session, receipt.sourceSession);
    assert.notEqual(session, receipt.analysisSession);
    assert.ok(events.some(event => event.kind === 'step.completed' && event.stepId === 'implement' && event.outcome === 'succeeded'));
    const { publication } = receipt;
    const origin = `knowledge:${publication.key}; target:${targetRef}`;
    assert.equal(retrievals.length, 1);
    const [{ query, origins }] = retrievals;
    assert.equal(query.scope, consumerScope);
    assert.ok(query.prompt.includes(question));
    assert.equal(query.applicability.environment, 'staging');
    assert.equal(query.target.project, consumerScope);
    assert.equal(query.target.productVersions.parcel, '2.0');
    assert.deepEqual(query.target.conditions, { pickup });
    const expectedOrigins = excluded ? [] : [origin];
    assert.deepEqual(origins, expectedOrigins);
    const literal = await gather({ ...query, prompt: question });
    const literalOrigins = literal.map(fragment => fragment.origin);
    save('literal-query.json', { question, origins: literalOrigins });
    assert.deepEqual(literalOrigins, expectedOrigins);
    if (crossProject) {
      const allowed = await gather({ ...query, scope, prompt: question, target: { ...query.target, project: scope } });
      const origins = allowed.map(fragment => fragment.origin);
      assert.deepEqual(origins, [origin]);
      save('source-project-control.json', { question, scope, origins });
    }
    if (pickup) {
      const allowed = await gather({ ...query, prompt: question, target: { ...query.target, conditions: { pickup: false } } });
      assert.deepEqual(allowed.map(fragment => fragment.origin), [origin]);
      save('nonpickup-control.json', { question, origins: [origin] });
    }
    const conditionControls = [];
    for (const conditions of [{ pickup: true }, {}]) {
      const fragments = await gather({ ...query, target: { ...query.target, conditions } });
      conditionControls.push({ conditions, origins: fragments.map(fragment => fragment.origin) });
    }
    save('excluded-conditions.json', conditionControls);
    assert.ok(conditionControls.every(control => control.origins.length === 0), 'Pickup and unknown pickup status must both exclude this procedure');
    assert.equal(events.some(event => event.command === 'experience.recall' && event.accepted), !excluded);
    const answer = join(workspace, 'answer.json');
    assert.ok(lstatSync(answer).isFile());
    if (excluded) {
      assert.deepEqual(read(answer), { steps: null, completion: null, source: null, productVersion: null });
      const transcript = JSON.parse(command('opencode', ['session', 'export', session, '--standalone'], { cwd: workspace, env: nativeEnv }));
      assert.equal(transcript.info.id, session);
      assert.ok(transcript.messages.length > 0);
      const contents = JSON.stringify(transcript.messages);
      assert.ok(contents.includes(question));
      for (const withheld of [publication.key, targetRef, ...receipt.authority.steps.map(step => step.stateChange)]) assert.ok(!contents.includes(withheld));
      save('session-check.json', { session, messages: transcript.messages.length, withheldProcessAbsent: true });
    } else gradeProcess(read(answer), receipt);
    save('verified.json', { caseId, question, runId, workItemId, session, origin: excluded ? null : origin, cliVersion: receipt.cliVersion,
      productVersion: receipt.productVersion, edition: receipt.edition, candidateId: publication.candidateId, evidenceDigest: publication.evidenceDigest,
      answerDigest: hash(readFileSync(answer)), steps: excluded ? 0 : receipt.authority.steps.length, status: 'verified' });
  } finally { await plugins.dispose(); }
}

function audit() {
  const { version, binary: installed, snapshot, source, requestKey } = read(join(home, 'intake.json'));
  assert.equal(installed, binary);
  const { job, candidates } = read(join(home, 'extraction.json'));
  assert.equal(job.jobId, requestKey);
  const processes = candidates.filter(candidate => candidate.proposal.kind === 'process');
  assert.equal(processes.length, 1);
  const [candidate] = processes;
  assert.equal(candidate.evidenceDigest, snapshot.digest);
  assert.equal(candidate.requestKey, requestKey);
  const { payload, evidenceIds } = candidate.proposal;
  const cited = (level, ids) => ids.map(id => {
    const ref = snapshot.entries.find(entry => entry.ref.id === id)?.ref;
    return { level, id, locator: ref?.locator, authority: ref?.authority, completeness: ref?.completeness };
  });
  const references = [...cited('candidate', evidenceIds), ...payload.steps.flatMap(step => cited(step.id, step.evidenceIds))];
  const sqlite = observe(database, source.bag);
  const extracted = { ...payload, steps: payload.steps.map(({ action, stateChange }) => ({ action, stateChange })) };
  const optional = name => existsSync(join(home, `${name}.json`)) ? read(join(home, `${name}.json`)) : null;
  const validation = optional('validation') ?? JSON.parse(optional('blocked')?.stdout || 'null');
  return { version, candidateId: candidate.id, sessionId: source.sessionId, job: job.status, evidenceDigest: snapshot.digest,
    sqlite, stepCount: sqlite.steps.length, payloadMatches: isDeepStrictEqual(sqlite, extracted), references, validation,
    runtimeCheckerInvoked: Boolean(optional('independent-check')), publication: optional('publication')?.phase ?? null,
    consumerRun: optional('consumer-run') ?? null };
}

try {
  if (mode === 'worker') await analyze();
  else if (mode === 'managed') await consume();
  else if (mode === 'consume') console.log(JSON.stringify(launchConsumer(realpathSync(parent || process.cwd()))));
  else if (mode === 'run' || publicReview) await pipeline();
  else if (mode === 'audit') console.log(JSON.stringify(audit(), null, 2));
  else throw new Error('Expected run, audit, worker or consume');
} catch (error) {
  if (mode === 'managed') save('consumer-error.json', { message: error.message });
  if (mode === 'run' || publicReview) save('blocked.json', { message: error.message, stdout: error.stdout?.toString().slice(-2000), stderr: error.stderr?.toString().slice(-2000),
    completed: ['intake', 'extraction', 'independent-check', 'validation', 'publication', 'consumer-run'].filter(name => existsSync(join(home, `${name}.json`))) });
  throw error;
}
