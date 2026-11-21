import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import type { RunEventData } from '@afk/core';
import type { ContextFragment, ContextQuery } from '@afk/runtime/plugin-sdk';
import { hash, page, wikiScript } from '../../../packages/runtime/src/application/learning/knowledge.fixture.spec.js';
import { openSqlite } from '../../../packages/runtime/src/infrastructure/storage/sqlite.js';
import { assertObservedRecall, recallCases } from './recall-v1.js';
import { driver, verifyManagedFact } from './managed-fact.js';

const execute = promisify(execFile);
const installed = process.env.AFK_E2E_CLI_ENTRY;
const scope = 'github:w11/parcel';
const rule = '封签点（截单点）之后，包裹改址须转人工。';
const handoff = {
  entry: 'return-handoff', systems: ['退件登记簿'], preconditions: ['收到退件'], exceptions: ['自提退件不走此路径'], completion: '已签收',
  steps: [{ action: '核对袋号', stateChange: '待核对 -> 已核对' }, { action: '登记签收', stateChange: '已核对 -> 已签收' }],
};

const authorityCases = ['fact-05', 'fact-06'];
type LiveSource = false | 'observations' | 'policy-receipt';
async function installedKnowledge(caseId: string, live: LiveSource = false) {
  if (!installed || !isAbsolute(installed)) throw new Error('AFK_E2E_CLI_ENTRY must name the installed CLI');
  const binary = await fs.realpath(installed);
  const release = dirname(dirname(binary));
  expect(binary).toBe(join(release, 'dist/index.js'));
  expect(binary.startsWith(await fs.realpath(fileURLToPath(new URL('../../../', import.meta.url))) + sep)).toBe(false);
  const expectedVersion = JSON.parse(await fs.readFile(new URL('../../../apps/cli/package.json', import.meta.url), 'utf8')).version;
  expect(JSON.parse(await fs.readFile(join(release, 'release.json'), 'utf8')).version).toBe(expectedVersion);
  const runtime = await fs.realpath(join(release, 'node_modules/@afk/runtime/dist'));
  expect(runtime.startsWith(`${release}/`)).toBe(true);
  await observeKnowledge(caseId, binary, runtime, expectedVersion, live);
}

it.skipIf(!installed).each(['fact-01', 'fact-02', 'fact-03', 'fact-04', ...authorityCases, 'process-01', 'process-02', 'process-03', 'process-04', 'process-05', 'process-06'])(
  'scores installed knowledge gather for local fixture %s', async caseId => installedKnowledge(caseId), 60_000);

it.runIf(process.env.AFK_W11_LIVE_FACT01 === '1')('distills installed fact-01 with one restricted Claude worker',
  { timeout: 200_000, retry: 0 }, () => installedKnowledge('fact-01', 'observations'));

it.runIf(process.env.AFK_W11_LIVE_POLICY_RECEIPT === '1')('distills installed parcel policy receipt with one restricted Claude worker',
  { timeout: 200_000, retry: 0 }, () => installedKnowledge('fact-01', 'policy-receipt'));

it.runIf(process.env.AFK_W11_LIVE_AUTHORITY === '1').each(authorityCases)('checks live authority for %s',
  async caseId => installedKnowledge(caseId, 'policy-receipt'), 400_000);

it.runIf(process.env.AFK_W11_WORKSPACE_RECALL === '1').each(authorityCases)('checks workspace knowledge gather for local fixture %s', async caseId => {
  const cli = new URL('../../../apps/cli/', import.meta.url);
  await observeKnowledge(caseId, fileURLToPath(new URL('dist/index.js', cli)), fileURLToPath(new URL('../../../packages/runtime/dist', import.meta.url)),
    JSON.parse(await fs.readFile(new URL('package.json', cli), 'utf8')).version);
}, 60_000);

function observeParcelRedirect(home: string, mode: Exclude<LiveSource, false>) {
  const db = openSqlite({ file: join(home, 'parcel.sqlite'), schema: `CREATE TABLE parcels (sealed INTEGER PRIMARY KEY, address TEXT, review TEXT);
      INSERT INTO parcels VALUES (0,'A',NULL),(1,'A',NULL);
      CREATE TRIGGER cutoff BEFORE UPDATE OF address ON parcels WHEN OLD.sealed = 1 BEGIN
        UPDATE parcels SET review = NEW.address WHERE sealed = OLD.sealed;
        SELECT RAISE(IGNORE);
      END;` });
  try {
    db.exec("UPDATE parcels SET address = 'B'");
    const rows = db.prepare(`SELECT CASE sealed WHEN 1 THEN '封签后' ELSE '封签前' END AS 包裹状态,
      address AS 实际收件地址, review AS 人工审核队列中的待改地址 FROM parcels ORDER BY sealed`).all();
    expect(rows).toEqual([{ 包裹状态: '封签前', 实际收件地址: 'B', 人工审核队列中的待改地址: null },
      { 包裹状态: '封签后', 实际收件地址: 'A', 人工审核队列中的待改地址: 'B' }]);
    const decision = db.prepare(`SELECT CASE WHEN address = 'A' AND review = 'B' THEN '须转人工'
      WHEN address = 'B' AND review IS NULL THEN '可直接办理' END AS outcome FROM parcels WHERE sealed = 1`).get();
    return JSON.stringify({ operation: '包裹改址 A → B', policy: 'seal-cutoff', policyPage: 'wiki:seal-cutoff',
      ...(mode === 'policy-receipt' && { appliedPolicy: { subject: 'seal-cutoff', rule: `封签点（截单点）之后，包裹改址${decision?.outcome}。` } }),
      environment: 'staging', parcelVersion: '2.0', rows });
  } finally { db.close(); }
}

async function observeKnowledge(caseId: string, binary: string, runtime: string, expectedVersion: string, live: LiveSource = false) {
  const entry = recallCases.find(item => item.id === caseId)!;
  const isProcess = entry.kind === 'process';
  const targetRef = isProcess ? 'wiki:return-handoff' : 'wiki:seal-cutoff';
  const pageName = isProcess ? 'ReturnHandoff.md' : 'Seal.md';
  const load = (name: string) => import(pathToFileURL(join(runtime, `${name}.js`)).href);
  const { CandidateStore } = await load('application/learning/candidate-store') as typeof import('../../../packages/runtime/src/application/learning/candidate-store.js');
  const { buildEvidencePack } = await load('application/learning/evidence') as typeof import('../../../packages/runtime/src/application/learning/evidence.js');
  const { JsonlEventStore } = await load('infrastructure/observability/jsonl-event-store') as typeof import('../../../packages/runtime/src/infrastructure/observability/jsonl-event-store.js');
  const keepUnder = live && process.env.AFK_W11_FACT01_FIXTURES;
  const home = await fs.realpath(await fs.mkdtemp(join(keepUnder || tmpdir(), `w11-installed-${caseId}-`)));
  try {
    const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), PATH: process.env.PATH,
      AFK_EVENT_STORE_DIR: join(home, 'events'), AFK_LOG_DIR: join(home, 'logs'), NO_COLOR: '1' };
    const cli = async (...args: string[]) => (await execute(process.execPath, [binary, ...args], { cwd: home, env, timeout: 20_000 })).stdout;
    const invoke = async (...args: string[]) => JSON.parse(await cli(...args, '--json'));
    const save = async (name: string, value: unknown) => {
      const file = join(home, name);
      await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
      return file;
    };
    expect((await cli('--version')).trim()).toBe(expectedVersion);
    const vault = join(home, 'wiki');
    const extension = join(home, 'checker');
    await Promise.all([vault, extension].map(path => fs.mkdir(path)));
    const rules = '# Local W11 fixture wiki\n';
    await fs.writeFile(join(vault, 'AGENTS.md'), rules);
    for (const [name, title, body] of [['template', '{{title}}', '{{knowledge}}'], ['index', 'Index', '[[links]]'], ['links', 'Links', '[[index]]']]) {
      await fs.writeFile(join(vault, `${name}.md`), page(title, body));
    }
    const grant = await save('grant.json', { version: 1, revoked: false, allowWithdrawal: true, policy: { scope, vault,
      rules: { 'AGENTS.md': hash(rules), '.tools/wiki-lint.py': null }, targets: [{ ref: targetRef, paths: [pageName], kinds: [entry.kind], snapshot: !isProcess,
        inbox: false, templatePath: 'template.md', indexPaths: ['index.md'], backlinkPaths: ['links.md'] }] } });
    const events = new JsonlEventStore({ root: env.AFK_EVENT_STORE_DIR });
    const runId = 'local-parcel-source';
    const workItemId = `${scope}#42`;
    const data: RunEventData[] = live ? [{ kind: 'qa.started' }, { kind: 'effect.completed', effectKind: 'parcel.redirect',
      idempotencyKey: 'parcel-rule', outcome: 'succeeded', summary: observeParcelRedirect(home, live) }, { kind: 'qa.passed' },
      { kind: 'run.finished', outcome: 'succeeded' }] : [{ kind: 'agent.session_recorded', sessionId: 'parcel-fixture' }];
    await events.append(data.map(item => ({ id: live ? item.kind : 'parcel-rule', schemaVersion: 1, type: item.kind, occurredAt: '2026-11-18T00:00:00Z',
      correlationId: runId, context: { runId, workItemId, traceId: runId, profileId: 'fixture', attempt: 1, actor: { kind: 'system', id: 'fixture' } },
      data: item })));
    const source = { id: 'audit-1', kind: 'audit' as const, allowedRoot: events.root, path: events.pathFor(runId), runId };
    const pack = await buildEvidencePack({ sources: [source] });
    const refs = pack.entries.map(entry => entry.ref);

    const identity = { scope, checkerId: 'parcel-rule', providerId: 'parcel-oracle', version: '1' };
    const authority = await save('authority.json', isProcess ? { ...handoff, applicability: { preconditions: [], exclusions: ['pickup'], invalidationConditions: [] } } : { subject: 'seal-cutoff', rule,
      authority: live ? pack.entries.filter(entry => JSON.parse(entry.content).data.kind === 'effect.completed').map(entry => entry.ref.locator) : refs.map(ref => ref.locator).sort() });
    const authorityPaths = entry.state === 'conflict' ? ['dispatch.json', 'operations.json'] : entry.state === 'expired' ? ['dispatch.json'] : undefined;
    const statement = { scope, targetRef, subject: 'seal-cutoff', rule, version: '2.0', environment: 'staging', validUntil: '2099-01-01T00:00:00Z' };
    for (const path of authorityPaths ?? []) await save(path, statement);
    const configurationFile = await save('checkers.json', { version: 1, checkers: [{ ...identity, authorizationFile: grant,
      target: { ref: targetRef, root: home, path: 'authority.json' }, factAuthorityPaths: authorityPaths, evidence: [{ digest: pack.digest, sources: [source] }] }] });
    const manifest = { id: 'verification.parcel-fixture', apiVersion: 1, version: '1.0.0', trusted: true, provides: ['verification.provider'], entry: 'index.js' };
    await save('checker/package.json', { name: 'parcel-fixture', type: 'module', version: '1.0.0' });
    await save('checker/plugin.json', manifest);
    await fs.writeFile(join(extension, 'index.js'), `import { readFileSync } from 'node:fs';
      const identity = ${JSON.stringify(identity)};
      export default () => ({ manifest: ${JSON.stringify(manifest)}, activate(context) {
        context.registerVerificationProvider(identity.providerId, { id: identity.providerId,
          capabilities: { 'test-execution': true, 'static-analysis': false, 'custom-script': false },
          async doctor() { return [{ check: 'learning-validation-v1', ok: true, detail: JSON.stringify(identity) }]; },
          async verify(request) {
            const { binding, assertions } = JSON.parse(request.target);
            const observed = JSON.parse(readFileSync(${JSON.stringify(authority)}, 'utf8'));
            return { passed: true, durationMs: 1, output: JSON.stringify({ protocol: 'learning-validation-v1', binding,
              assertions: assertions.map(assertion => ({ ...assertion, status: 'observed',
                actual: assertion.node === 'process.stepCount' ? String(observed.steps.length) : assertion.node.split('.').slice(1).reduce((value, field) => value[field], observed) })) }) };
          } }); } });`);
    await cli('plugin', 'install', extension);
    const readGrant = { scope, targetRef, evidenceDigest: pack.digest, paths: [source.path, authority, ...(authorityPaths ?? []).map(path => join(home, path))], revoked: false };
    const sourceReadGrantFile = entry.state === 'revoked' || authorityPaths ? await save('source-access.json', { version: 1, grants: [readGrant] }) : undefined;
    await cli('plugin', 'configure', 'learning.distiller', '--builtin', '--file', await save('distiller.json', { enabled: true, dailyCalls: 0,
      ...(live && { executionContexts: [{ applicability: { environment: 'staging', version: '2.0' }, target: { project: scope, productVersions: { parcel: '2.0' } } }] }),
      knowledge: { wikiScript, grants: [grant], sourceReadGrantFile }, validation: { configurationFile } }));
    let candidateId: string;
    if (live) {
      const { reconcileDistillationSources } = await load('execution') as typeof import('../../../packages/runtime/src/execution.js');
      const directory = join(home, '.afk/learning');
      const capture = await reconcileDistillationSources({ directory, eventRoot: events.root, homeDir: home, scope, runId, workItemId });
      expect(capture).toMatchObject({ submitted: 1, blocked: [], requestKeys: [expect.stringMatching(/^[a-f0-9]{64}$/)] });
      const target = { scope, requestKey: capture.requestKeys[0] };
      console.log(JSON.stringify({ caseId, sourceMode: live, home, binary, evidenceDigest: pack.digest, ...target }));
      const authHome = process.env.AFK_REAL_DISTILLATION_HOME;
      if (!authHome || !isAbsolute(authHome)) throw new Error('AFK_REAL_DISTILLATION_HOME must name the authenticated home');
      const workerEnv = { ...env, HOME: authHome, USERPROFILE: authHome, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN };
      const loggedIn = await execute('claude', ['auth', 'status', '--json'], { cwd: home, env: workerEnv, timeout: 10_000 })
        .then(result => JSON.parse(result.stdout).loggedIn === true, () => false);
      expect(loggedIn, 'Claude authentication for restricted analysis').toBe(true);
      const workerScript = `import { LearningWorker, executeAnalysis, parseAnalysisOutput } from ${JSON.stringify(pathToFileURL(join(runtime, 'execution.js')).href)};
        import { ClaudeCodeProvider } from ${JSON.stringify(pathToFileURL(join(runtime, 'domain/agents/claude-code.js')).href)};
        import { CandidateStore } from ${JSON.stringify(pathToFileURL(join(runtime, 'application/learning/candidate-store.js')).href)};
        const ledger = new CandidateStore({ file: ${JSON.stringify(join(directory, 'candidates.sqlite'))} });
        const { request } = ledger.getRequest(${JSON.stringify(target.requestKey)});
        const snapshot = ledger.getEvidencePack(request.evidenceDigest);
        ledger.close();
        const worker = new LearningWorker({ directory: ${JSON.stringify(directory)}, dailyCalls: 1, enabled: true, provider: new ClaudeCodeProvider(),
          analyze: async input => {
            const result = await executeAnalysis(input);
            try { parseAnalysisOutput(result.output, request, snapshot); }
            catch (error) {
              const issues = Array.isArray(error.issues) ? error.issues.map(({ code, path }) => ({ code, path })) : [];
              const reason = ['Unknown evidence reference', 'Candidate project differs from request scope', 'Partial evidence requires explicit process gaps'].includes(error.message) ? error.message : 'invalid_structure';
              console.log(JSON.stringify({ reason, issues }));
            }
            return result;
          } });
        try { await worker.runOnce(${JSON.stringify(target)}); } finally { await worker.close(); }`;
      const analysis = await execute(process.execPath, ['--input-type=module', '--eval', workerScript], { cwd: home, env: workerEnv, timeout: 145_000 });
      if (analysis.stdout.trim()) console.log(analysis.stdout.trim());
      const { queryLearningRequest } = await load('application/learning/worker') as typeof import('../../../packages/runtime/src/application/learning/worker.js');
      const { job, candidates } = queryLearningRequest({ directory, ...target });
      console.log(JSON.stringify({ status: job.status, reason: job.reasonCode, calls: job.attempts.length, kinds: candidates.map(item => item.proposal.kind) }));
      expect(job).toMatchObject({ status: 'processed', attempts: [expect.objectContaining({ status: 'succeeded' })] });
      const facts = candidates.filter(item => item.proposal.kind === 'fact');
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({ state: 'candidate', version: 1, evidenceDigest: pack.digest, requestKey: target.requestKey });
      candidateId = facts[0].id;
    } else {
      const ledger = new CandidateStore({ file: join(home, '.afk/learning/candidates.sqlite') });
      try {
        const request = ledger.submitRequest({ request: { version: 1, scope, workItemId, sourceId: `run:${runId}`, sourceRunId: runId,
          evidenceDigest: pack.digest, analyzerVersion: 'local-fixture', reason: 'import' }, evidence: refs }, pack);
        const evidenceIds = refs.map(ref => ref.id);
        const proposal = isProcess ? { kind: 'process', title: '退件交接', statement: '退件交接（逆向移交）先核对袋号，再登记签收。自提退件不走此路径。',
          payload: { ...handoff, steps: handoff.steps.map((step, index) => ({ ...step, id: ['check-bag', 'sign'][index], evidenceIds })) } } as const
          : { kind: 'fact', title: '封签点', statement: rule, payload: { subject: 'seal-cutoff', rule, classification: 'fact' } } as const;
        const result = ledger.completeRequest(request.key, { version: 1, warnings: [], candidates: [{ ...proposal, targetRef, evidenceIds,
          applicability: { project: scope, environments: ['staging'], versions: ['2.0'], preconditions: [], exclusions: isProcess ? ['pickup'] : [], invalidationConditions: [] } }] });
        [candidateId] = result.candidateIds;
        expect(ledger.getCandidate(candidateId)).toMatchObject({ state: 'candidate', version: 1 });
      } finally { ledger.close(); }
    }
    const validation = await invoke('experience', 'validate', candidateId, '--scope', scope, '--expected-version', '1', '--checker', identity.checkerId);
    expect(validation).toMatchObject({ status: 'validated', candidateId, receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/), validatedVersion: 2 });
    const prepared = await invoke('experience', 'knowledge', 'prepare', candidateId, '--scope', scope, '--expected-version', String(validation.validatedVersion));
    const { publication } = await invoke('experience', 'knowledge', 'publish', prepared.key, '--scope', scope);
    expect(publication).toMatchObject({ phase: 'committed', key: prepared.key, candidateId, targetRef, evidenceDigest: pack.digest,
      candidateVersion: validation.validatedVersion, validatorVersion: `learning-validation-v1:${validation.executionId}` });
    const pagePath = join(vault, pageName);
    const content = await fs.readFile(pagePath, 'utf8');
    const material = JSON.parse(/\n```json\n([^\n]+)\n```/.exec(content)![1]);
    expect(material).toMatchObject({ evidenceDigest: publication.evidenceDigest, proposal: { kind: entry.kind, targetRef: publication.targetRef,
      applicability: { project: scope }, payload: isProcess ? handoff : { rule } } });
    const key = isProcess ? material.proposal.payload.entry : material.proposal.payload.subject;
    expect(publication.targetRef).toBe(`wiki:${key}`);
    const gather = async (query: ContextQuery): Promise<ContextFragment[]> => invoke('plugin', 'invoke', 'context.provider', 'context.knowledge', 'gather',
      '--input', await save('query.json', { ...query, applicability: { ...query.applicability, version: query.target?.productVersions?.parcel } }));
    const positive = recallCases.find(item => item.id === `${entry.kind}-01`)!;
    const deadline = Date.now() + 5_000;
    if (entry.state === 'expired') await save('dispatch.json', { ...statement, validUntil: new Date(deadline).toISOString() });
    const control = await gather({ ...positive.query, prompt: entry.query.prompt });
    const origin = `knowledge:${publication.key}; target:${publication.targetRef}`;
    expect(control).toEqual([{ origin, content }]);
    if (entry.state === 'conflict') await save('operations.json', { ...statement, rule: '封签点之后，包裹仍可直接改址。' });
    if (entry.state === 'expired') {
      expect(Date.now()).toBeLessThan(deadline);
      await delay(deadline - Date.now());
    }
    const observedAt = Date.now();
    const authorities = await Promise.all((authorityPaths ?? []).map(async path => ({ path, ...JSON.parse(await fs.readFile(join(home, path), 'utf8')) })));
    if (entry.state === 'conflict') {
      expect(authorities.map(record => record.rule)).toEqual([rule, '封签点之后，包裹仍可直接改址。']);
      expect(authorities.every(record => Date.parse(record.validUntil) > observedAt)).toBe(true);
    }
    if (entry.state === 'expired') expect(Date.parse(authorities[0].validUntil)).toBeLessThanOrEqual(observedAt);
    if (caseId === 'fact-02') {
      expect(await gather({ ...positive.query, prompt: '截单点' })).toEqual(control);
      expect(await gather({ ...positive.query, prompt: '截点' })).toEqual([]);
    }
    let withdrawal;
    if (entry.state === 'revoked') {
      const originalSource = await fs.readFile(source.path);
      await save('source-access.json', { version: 1, grants: [{ ...readGrant, revoked: true }] });
      expect(await gather(entry.query)).toEqual([]);
      expect(await fs.readFile(source.path)).toEqual(originalSource);
      expect(await fs.readFile(pagePath, 'utf8')).toBe(content);
      const reader = new CandidateStore({ file: join(home, '.afk/learning/candidates.sqlite') });
      try { expect(reader.getPublication(publication.key)).toMatchObject({ phase: 'committed', candidateId, evidenceDigest: pack.digest }); }
      finally { reader.close(); }
    }
    if (entry.state === 'withdrawn') {
      await save('authority.json', { ...handoff, completion: '已停止交接' });
      const reconciled = await invoke('experience', 'knowledge', 'reconcile', '--scope', scope);
      expect(reconciled).toMatchObject({ blocked: [], results: [{ publication: { key: publication.key },
        withdrawal: { key: publication.key, candidateVersion: publication.candidateVersion, evidenceDigest: pack.digest, status: 'withdrawn' } }] });
      withdrawal = reconciled.results[0].withdrawal;
      expect(await fs.readFile(pagePath, 'utf8')).toContain('knowledge_status: revoked');
      await save('authority.json', handoff);
    }
    const actual = entry === positive ? control : await gather(entry.query);
    if (authorityPaths) {
      const reconciled = await invoke('experience', 'knowledge', 'reconcile', '--scope', scope);
      expect(reconciled).toMatchObject({ blocked: [], results: [{ publication: { phase: 'committed', key: publication.key, candidateId } }] });
      expect(reconciled.results[0].withdrawal).toBeUndefined();
      expect(await fs.readFile(pagePath, 'utf8')).toBe(content);
      const restoreAuthority = async () => {
        for (const path of authorityPaths) await save(path, statement);
      };
      if (live) {
        const runDirectory = await fs.mkdtemp(join(home, 'managed-'));
        const gate = await execute(process.execPath, [driver, 'gate', runtime, home, binary, JSON.stringify(positive)], { env, cwd: home });
        const receipt = JSON.parse(gate.stdout);
        expect(receipt).toMatchObject({ publication: { key: publication.key }, producerSession: expect.any(String), producerRun: expect.any(String) });
        await verifyManagedFact({ binary, runtime, fixture: home, runDirectory, itemId: entry.state === 'conflict' ? '47' : '48',
          cliVersion: expectedVersion, entryCase: entry, receipt, restoreAuthority });
      } else await restoreAuthority();
      expect(await gather(entry.query)).toEqual(control);
    }
    const ranked = actual.map(fragment => {
      expect(fragment).toEqual({ origin, content });
      return { scope: material.proposal.applicability.project, key, edition: publication.candidateVersion };
    });
    assertObservedRecall(entry, { caseId, status: 'observed', ranked });
    console.log(JSON.stringify({ caseId, assetSource: live ? 'restricted-claude-worker' : 'local-fixture', binary, runtime, validation: validation.receiptDigest, publication: publication.key,
      controlOrigin: control[0].origin, productVersion: entry.query.target?.productVersions?.parcel, withdrawal, ranked,
      ...(authorityPaths && { authorities, observedAt: new Date(observedAt).toISOString(), pageDigest: hash(content) }) }));
  } finally { if (!keepUnder) await fs.rm(home, { recursive: true, force: true }); }
}
