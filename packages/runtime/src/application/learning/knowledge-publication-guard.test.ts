import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import { CandidateStore, type ValidationReceipt } from './candidate-store.js';
import { candidateProposalSchema } from './contracts.js';
import { buildEvidencePack } from './evidence.js';
import { assertCurrentKnowledgePublication, type KnowledgePublicationInput } from './knowledge-publication-guard.js';
import type { KnowledgePolicy } from './knowledge.js';
import { canonicalLearningJson } from './requests.js';
import { validationConfigurationSchema, type ValidationConfiguration } from './validation-configuration.js';
import { readValidationPrivateFile } from './validation-files.js';

const bytesDigest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => bytesDigest(canonicalLearningJson(value));
const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); cleanups.splice(0).reverse().forEach(cleanup => cleanup()); });

async function fixture(kind: 'fact' | 'process' = 'fact', configurationVersion: 1 | 2 = 1, managed = false, sessionHome?: string, replay = false) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'knowledge-publication-contract-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'ledger.sqlite');
  let store = new CandidateStore({ file });
  cleanups.push(() => store.close());
  const scope = 'github:acme/local-contract';
  const events = new JsonlEventStore({ root: join(root, 'audit') });
  const sessionRoot = sessionHome && join(sessionHome, '.codex', 'sessions');
  const transcript = sessionRoot && join(sessionRoot, 'source.jsonl');
  if (sessionRoot && transcript) {
    mkdirSync(sessionRoot, { recursive: true });
    writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: 'Approval observation' } }) + '\n');
  }
  const data = [{ kind: 'qa.started' as const }, ...(transcript
    ? [{ kind: 'agent.session_recorded' as const, sessionId: 'source-session', transcriptPath: transcript }] : []),
  { kind: 'qa.passed' as const }, { kind: 'run.finished' as const, outcome: 'succeeded' as const }];
  await events.append(data.map((entry, index) => ({ id: `observation-${index}`, schemaVersion: 1 as const, type: entry.kind,
    occurredAt: '2026-11-17T00:00:00Z', context: { runId: 'source-run', workItemId: `${scope}#1`, traceId: 'local-contract', profileId: 'fixture', attempt: 1,
      actor: { kind: 'system' as const, id: 'fixture' } }, correlationId: 'source-run', data: entry })));
  const evidenceSource = { id: 'audit-1', kind: 'audit' as const, path: events.pathFor('source-run'), allowedRoot: events.root, runId: 'source-run' };
  const pack = await buildEvidencePack({ sources: [evidenceSource, ...(sessionRoot && transcript
    ? [{ id: 'session-1', kind: 'session' as const, path: transcript, allowedRoot: sessionRoot }] : [])] });
  const evidenceIds = [pack.entries[0].ref.id];
  const common = { title: 'Local approval', statement: 'Approval precedes publication', evidenceIds, targetRef: 'wiki:approval',
    applicability: { project: scope, environments: [], versions: [], preconditions: [], exclusions: [], invalidationConditions: [] } };
  const proposal = candidateProposalSchema.parse(kind === 'fact'
    ? { ...common, kind, payload: { subject: 'release', rule: 'approval required', classification: 'fact' } }
    : { ...common, kind, payload: { entry: 'draft', systems: ['release-service'], preconditions: ['authenticated'],
      steps: [{ id: 'approve', action: 'approve', stateChange: 'draft -> approved', evidenceIds }], exceptions: ['denied'], completion: 'approved' } });
  const submission = { request: { version: 1 as const, scope, sourceId: 'source-run', sourceRunId: 'source-run', workItemId: `${scope}#1`,
    evidenceDigest: pack.digest, analyzerVersion: 'local-contract', reason: 'completed' as const }, evidence: pack.entries.map(entry => entry.ref) };
  const history = readFileSync(evidenceSource.path, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  const source = managed ? store.commitScan({ scope, runId: 'source-run', analyzerVersion: 'local-contract', sourceRoot: events.root,
    expectedCursor: null, cursor: { sequence: history.length, head: history.at(-1).integrity.hash }, requests: [submission] }, [pack])[0]!
    : store.submitRequest(submission, pack);
  const job = replay ? store.submitReplay({ scope, requestKey: source.key, revision: 'v2' }) : source;
  const candidateId = store.completeRequest(job.key, { version: 1, candidates: [proposal], warnings: [] }).candidateIds[0]!;
  const original = store.getCandidate(candidateId)!;
  const vault = join(root, 'vault');
  mkdirSync(vault);
  writeFileSync(join(vault, 'AGENTS.md'), '# Local contract rules\n');
  writeFileSync(join(vault, 'template.md'), '# Template\n');
  const policy: KnowledgePolicy = { scope, vault,
    rules: { 'AGENTS.md': bytesDigest(readFileSync(join(vault, 'AGENTS.md'))), '.tools/wiki-lint.py': null },
    targets: [{ ref: 'wiki:approval', paths: ['Approval.md'], kinds: ['fact', 'process'], inbox: false,
      templatePath: 'template.md', indexPaths: ['index.md'], backlinkPaths: ['backlinks.md'] }] };
  const grant = { version: 1, revoked: false, allowWithdrawal: true, policy };
  const authorizationFile = join(root, 'validator-grant.json');
  const persistGrant = () => writeFileSync(authorizationFile, JSON.stringify(grant), { mode: 0o600 });
  persistGrant();
  const targetRoot = join(root, 'oracle');
  mkdirSync(targetRoot);
  const targetPath = join(targetRoot, 'approval.json');
  writeFileSync(targetPath, '{"approvalRequired":true}\n');
  const checker = { scope, checkerId: 'local-checker', providerId: 'local-semantic', version: '1', authorizationFile,
    target: { ref: 'wiki:approval', root: targetRoot, path: 'approval.json' }, evidence: [{ digest: pack.digest, sources: [evidenceSource] }] };
  const config: ValidationConfiguration = configurationVersion === 1
    ? { version: 1, checkers: [checker] } : { version: 2, checkers: [{ mode: 'knowledge', ...checker }] };
  const configurationFile = join(root, 'checkers.json');
  const persistConfig = () => writeFileSync(configurationFile, JSON.stringify(config), { mode: 0o600 });
  persistConfig();
  const targetDigest = bytesDigest(readFileSync(targetPath));
  const binding = { scope, candidateId: original.id, candidateVersion: original.version, candidateDigest: original.digest,
    evidenceDigest: original.evidenceDigest, checkerId: checker.checkerId, checkerVersion: checker.version,
    configurationDigest: readValidationPrivateFile(configurationFile).fingerprint,
    authorizationDigest: digest([readValidationPrivateFile(configurationFile).fingerprint, readValidationPrivateFile(authorizationFile).fingerprint, grant]),
    executionId: randomUUID(), target: { scope, ref: checker.target.ref, revision: `sha256:${targetDigest}`, snapshotDigest: targetDigest } };
  const assertions: Array<{ node: string; expected: string | string[]; actual: string | string[]; status: 'observed';
    evidence: Array<{ id: string; digest: string; locator: string }> }> = [];
  const add = (node: string, expected: string | string[], ids = evidenceIds) => assertions.push({ node, expected, actual: expected, status: 'observed',
    evidence: ids.map(id => { const ref = pack.entries.find(entry => entry.ref.id === id)!.ref; return { id, digest: ref.digest, locator: ref.locator }; }) });
  if (proposal.kind === 'fact') {
    add('fact.subject', proposal.payload.subject);
    add('fact.rule', proposal.payload.rule);
    add('fact.authority', evidenceIds.map(id => pack.entries.find(entry => entry.ref.id === id)!.ref.locator).sort());
  } else if (proposal.kind === 'process') {
    add('process.entry', proposal.payload.entry);
    for (const field of ['preconditions', 'exclusions', 'invalidationConditions'] as const) add(`process.applicability.${field}`, proposal.applicability[field]);
    add('process.systems', proposal.payload.systems);
    add('process.preconditions', proposal.payload.preconditions);
    add('process.stepCount', String(proposal.payload.steps.length));
    proposal.payload.steps.forEach((step, index) => {
      add(`process.steps.${index}.action`, step.action, step.evidenceIds);
      add(`process.steps.${index}.stateChange`, step.stateChange, step.evidenceIds);
    });
    add('process.exceptions', proposal.payload.exceptions);
    add('process.completion', proposal.payload.completion);
  }
  const report = { protocol: 'learning-validation-v1', binding, assertions };
  const envelope = { report, receiptDigest: digest(report) };
  const encode = (value: unknown) => Buffer.from(canonicalLearningJson(value)).toString('base64').match(/.{1,1800}/g)!.map(chunk => `json-base64-v1:${chunk}`);
  const candidate = store.recordValidation(original.id, original.version, { candidateDigest: original.digest, evidenceDigest: original.evidenceDigest,
    validatorVersion: `learning-validation-v1:${binding.executionId}`, passed: true, results: encode(envelope) });
  const receipt = store.getValidation(candidate.id)!;
  const input: KnowledgePublicationInput = { store, candidate, configurationFile };
  const replaceReceipt = (overrides: Partial<ValidationReceipt>) => vi.spyOn(store, 'getValidation').mockReturnValue({ ...receipt, ...overrides });
  const rewrite = (change: (value: typeof envelope) => void, checksum = true) => {
    const value = structuredClone(envelope);
    change(value);
    if (checksum) value.receiptDigest = digest(value.report);
    replaceReceipt({ results: encode(value) });
  };
  const refreshBindings = () => {
    binding.configurationDigest = readValidationPrivateFile(configurationFile).fingerprint;
    binding.authorizationDigest = digest([binding.configurationDigest, readValidationPrivateFile(authorizationFile).fingerprint, grant]);
    rewrite(() => {});
  };
  const publish = () => {
    const publication = store.preparePublication(candidate.id, candidate.version, { key: 'local-publication', validatorVersion: receipt.validatorVersion,
      targetRef: 'wiki:approval', originalDigest: null, targetDigest: digest('local-page'), recoveryRef: 'local:publication' });
    store.advancePublication(publication.key, 'applied', publication.targetDigest);
    store.advancePublication(publication.key, 'committed', publication.targetDigest);
    input.candidate = store.getCandidate(candidate.id)!;
  };
  const reopen = () => { store.close(); store = new CandidateStore({ file }); input.store = store; };
  return { root, vault, store, input, candidate, source, pack, checker, config, configurationFile, authorizationFile, targetPath,
    grant, receipt, envelope, encode, persistConfig, persistGrant, rewrite, replaceReceipt, refreshBindings, publish, reopen };
}

describe('fact/process publication guard local contract with synthetic receipts', () => {
  it.each(['fact', 'process'] as const)('rechecks a managed %s session only under the trusted homeDir', async kind => {
    const homeDir = mkdtempSync(join(realpathSync(tmpdir()), 'knowledge-trusted-home-'));
    cleanups.push(() => rmSync(homeDir, { recursive: true, force: true }));
    const systemHome = realpathSync(homedir());
    expect(homeDir).not.toBe(systemHome);
    const current = await fixture(kind, 1, true, homeDir);
    expect(current.pack.sources.some(source => source.kind === 'session')).toBe(true);
    expect(() => assertCurrentKnowledgePublication({ ...current.input, homeDir })).not.toThrow();
    expect(() => assertCurrentKnowledgePublication(current.input)).toThrow('knowledge_publication_source_unavailable');
    expect(() => assertCurrentKnowledgePublication({ ...current.input, homeDir: systemHome }))
      .toThrow('knowledge_publication_source_unavailable');
    expect(current.store.getCandidate(current.candidate.id)).toEqual(current.candidate);
    expect(current.store.getValidation(current.candidate.id)).toEqual(current.receipt);
  });

  it.each([false, true])('rechecks frozen replay evidence for publication with managed source %s', async managed => {
    const current = await fixture('fact', 1, managed, undefined, true);
    expect(current.candidate.requestKey).not.toBe(current.source.key);
    expect(current.candidate.evidenceDigest).toBe(current.source.request.evidenceDigest);
    if (managed) {
      Reflect.deleteProperty(current.checker, 'evidence');
      current.persistConfig();
      current.refreshBindings();
    }
    expect(() => assertCurrentKnowledgePublication(current.input)).not.toThrow();
    current.publish();
    expect(() => assertCurrentKnowledgePublication(current.input)).not.toThrow();
    writeFileSync(join(current.root, 'audit', `${Buffer.from('source-run').toString('base64url')}.jsonl`), 'changed\n');
    expect(() => assertCurrentKnowledgePublication(current.input)).toThrow('knowledge_publication_source_unavailable');
    expect(current.store.invalidateRequestSource(current.source.key)).toBe(true);
    expect(current.store.getCandidate(current.candidate.id)?.state).toBe('conflict');
  });

  it('requires the requested checker to match the current process validation receipt', async () => {
    const current = await fixture('process');
    expect(() => assertCurrentKnowledgePublication({ ...current.input, checkerId: 'local-checker' })).not.toThrow();
    expect(() => assertCurrentKnowledgePublication({ ...current.input, checkerId: 'foreign-checker' }))
      .toThrow('knowledge_publication_checker_mismatch');
  });

  it.each(['fact', 'process'] as const)('accepts strict %s receipts at validated and published versions after ledger reopen', async kind => {
    const current = await fixture(kind);
    expect(current.input.candidate.version).toBe(2);
    expect(() => assertCurrentKnowledgePublication(current.input)).not.toThrow();
    current.publish();
    expect(current.input.candidate).toMatchObject({ state: 'published', version: 3 });
    current.reopen();
    expect(() => assertCurrentKnowledgePublication(current.input)).not.toThrow();
    expect(current.input.store.getValidation(current.candidate.id)).toEqual(current.receipt);
  });

  it.each(['fact', 'process'] as const)('accepts saved v2 knowledge configuration for %s', async kind => {
    const current = await fixture(kind, 2);
    expect(() => assertCurrentKnowledgePublication(current.input)).not.toThrow();
  });

  it('rechecks a registered managed source without a configuration manifest', async () => {
    const current = await fixture('process', 1, true);
    Reflect.deleteProperty(current.checker, 'evidence');
    current.persistConfig();
    current.refreshBindings();
    expect(() => assertCurrentKnowledgePublication(current.input)).not.toThrow();
    writeFileSync(current.pack.sources.length ? join(current.root, 'audit', `${Buffer.from('source-run').toString('base64url')}.jsonl`) : '', 'changed\n');
    expect(() => assertCurrentKnowledgePublication(current.input)).toThrow('knowledge_publication_source_unavailable');
  });

  it.each(['absent', 'deleted', 'changed', 'version', 'checker', 'scope', 'unsafe'] as const)('rejects configuration drift: %s', async defect => {
    const current = await fixture();
    if (defect === 'absent') current.input.configurationFile = undefined;
    if (defect === 'deleted') rmSync(current.configurationFile);
    if (defect === 'changed') { current.checker.providerId = 'different-provider'; current.persistConfig(); }
    if (defect === 'unsafe') chmodSync(current.configurationFile, 0o644);
    if (defect === 'version' || defect === 'checker' || defect === 'scope') {
      if (defect === 'version') current.checker.version = '2';
      if (defect === 'checker') current.checker.checkerId = 'other-checker';
      if (defect === 'scope') current.checker.scope = 'github:foreign/project';
      current.persistConfig();
      current.refreshBindings();
    }
    expect(() => assertCurrentKnowledgePublication(current.input)).toThrow('knowledge_publication_configuration_unavailable');
  });

  it.each(['revoked', 'deleted', 'kind', 'rules', 'unlisted-rule'] as const)('rechecks original validator authorization: %s', async defect => {
    const current = await fixture();
    if (defect === 'revoked') { current.grant.revoked = true; current.persistGrant(); current.refreshBindings(); }
    if (defect === 'deleted') rmSync(current.authorizationFile);
    if (defect === 'kind') { current.grant.policy.targets[0].kinds = ['process']; current.persistGrant(); current.refreshBindings(); }
    if (defect === 'rules') writeFileSync(join(current.vault, 'AGENTS.md'), '# Changed\n');
    if (defect === 'unlisted-rule') { mkdirSync(join(current.vault, '.tools')); writeFileSync(join(current.vault, '.tools', 'wiki-lint.py'), 'changed\n'); }
    expect(() => assertCurrentKnowledgePublication(current.input)).toThrow('knowledge_publication_authorization_changed');
  });

  it.each(['fact', 'process'] as const)('rejects changed oracle target for published %s without changing Wiki destination', async kind => {
    const current = await fixture(kind);
    current.publish();
    writeFileSync(current.targetPath, '{"approvalRequired":false}\n');
    expect(() => assertCurrentKnowledgePublication(current.input)).toThrow('knowledge_publication_target_changed');
  });

  it.each(['bytes', 'missing', 'manifest', 'blocked'] as const)('requires reproducible source evidence: %s', async defect => {
    const current = await fixture('process');
    const sourcePath = current.checker.evidence[0].sources[0].path;
    if (defect === 'bytes') writeFileSync(sourcePath, 'changed\n');
    if (defect === 'missing') rmSync(sourcePath);
    if (defect === 'manifest') { Reflect.deleteProperty(current.checker, 'evidence'); current.persistConfig(); current.refreshBindings(); }
    if (defect === 'blocked') vi.spyOn(current.store, 'getRequest').mockReturnValue({ ...current.source, blockedReason: 'source unavailable' });
    expect(() => assertCurrentKnowledgePublication(current.input)).toThrow(/^knowledge_publication_/);
  });

  it.each(['legacy', 'base64', 'utf8', 'checksum', 'protocol', 'extra', 'missing', 'execution', 'version', 'candidate', 'digest',
    'scope', 'target', 'revision', 'assertion', 'coverage', 'duplicate', 'evidence', 'inferred', 'failed', 'validator', 'outer-version'] as const)
    ('rejects damaged or replayed receipts: %s', async defect => {
      const current = await fixture('process');
      if (defect === 'legacy') current.replaceReceipt({ results: ['evidence and scope verified'] });
      else if (defect === 'base64') current.replaceReceipt({ results: ['json-base64-v1:!!!!'] });
      else if (defect === 'utf8') current.replaceReceipt({ results: [`json-base64-v1:${Buffer.from([0xff]).toString('base64')}`] });
      else if (defect === 'failed') current.replaceReceipt({ passed: false });
      else if (defect === 'validator') current.replaceReceipt({ validatorVersion: 'learning-validation-v1:other' });
      else if (defect === 'outer-version') current.replaceReceipt({ validatedVersion: 3 });
      else current.rewrite(value => {
        if (defect === 'checksum') value.receiptDigest = '0'.repeat(64);
        if (defect === 'protocol') value.report.protocol = 'learning-validation-v0';
        if (defect === 'extra') Object.assign(value, { unexpected: true });
        if (defect === 'missing') Reflect.deleteProperty(value.report.binding, 'authorizationDigest');
        if (defect === 'execution') Object.assign(value.report.binding, { execution: { protocol: 'learning-fact-command-v1' } });
        if (defect === 'version') value.report.binding.candidateVersion++;
        if (defect === 'candidate') value.report.binding.candidateId = '0'.repeat(64);
        if (defect === 'digest') value.report.binding.candidateDigest = '0'.repeat(64);
        if (defect === 'scope') value.report.binding.scope = 'github:foreign/project';
        if (defect === 'target') value.report.binding.target.ref = 'wiki:other';
        if (defect === 'revision') value.report.binding.target.revision = 'unverified-revision';
        if (defect === 'assertion') value.report.assertions[0].actual = 'invented';
        if (defect === 'coverage') value.report.assertions.pop();
        if (defect === 'duplicate') value.report.assertions[1] = structuredClone(value.report.assertions[0]);
        if (defect === 'evidence') value.report.assertions[0].evidence[0].digest = '0'.repeat(64);
        if (defect === 'inferred') Object.assign(value.report.assertions[0], { status: 'inferred' });
      }, defect !== 'checksum');
      expect(() => assertCurrentKnowledgePublication(current.input)).toThrow(/^knowledge_publication_/);
    });

  it.each(['validated', 'published'] as const)('rejects receipt version inconsistent with persisted %s candidate', async state => {
    const current = await fixture();
    if (state === 'published') current.publish();
    const changed = { ...current.input.candidate, version: current.input.candidate.version + 1 };
    current.input.candidate = changed;
    vi.spyOn(current.store, 'getCandidate').mockReturnValue(changed);
    expect(() => assertCurrentKnowledgePublication(current.input)).toThrow('knowledge_publication_invalid_receipt');
  });

  it.each(['validated', 'published'] as const)('requires independent routing conditions for a previously %s process', async state => {
    const current = await fixture('process');
    if (state === 'published') current.publish();
    current.rewrite(value => {
      value.report.assertions = value.report.assertions.filter(assertion => !assertion.node.startsWith('process.applicability.'));
    });
    expect(() => assertCurrentKnowledgePublication(current.input)).toThrow('knowledge_publication_invalid_receipt');
  });

  it('rejects stale input and a receipt changed during final candidate reload', async () => {
    const current = await fixture();
    expect(() => assertCurrentKnowledgePublication({ ...current.input, candidate: { ...current.candidate, version: 9 } })).toThrow('knowledge_publication_stale_candidate');
    const getCandidate = current.store.getCandidate.bind(current.store);
    let reads = 0;
    vi.spyOn(current.store, 'getCandidate').mockImplementation(id => {
      if (++reads === 2) current.replaceReceipt({ passed: false });
      return getCandidate(id);
    });
    expect(() => assertCurrentKnowledgePublication(current.input)).toThrow('knowledge_publication_stale_candidate');
  });

  it('blocks fact-command configuration even with a semantic passed receipt and refreshed authorization digests', async () => {
    const current = await fixture();
    const command = '/isolated/checker';
    const configured = { ...current.checker, mode: 'fact-command', kind: 'fact', executionAuthorizationFile: join(current.root, 'execution-grant.json'),
      execution: { command: [command], timeoutMs: 1000, checkerFiles: [{ path: command, digest: 'a'.repeat(64) }],
        workspace: { kind: 'repository', providerId: 'local', id: 'local-contract', revision: 'a'.repeat(40), cwd: '/isolated/workspace' } } };
    const config = validationConfigurationSchema.parse({ version: 2, checkers: [configured] });
    writeFileSync(current.configurationFile, JSON.stringify(config), { mode: 0o600 });
    current.refreshBindings();
    expect(() => assertCurrentKnowledgePublication(current.input)).toThrow('knowledge_publication_unsupported_fact_command');
  });

  it('honors cancellation and deadline without exposing local paths', async () => {
    const current = await fixture();
    const controller = new AbortController();
    controller.abort();
    expect(() => assertCurrentKnowledgePublication(current.input, { signal: controller.signal })).toThrow('knowledge_publication_cancelled');
    expect(() => assertCurrentKnowledgePublication(current.input, { deadlineAt: 0 })).toThrow('knowledge_publication_timed_out');
    rmSync(current.targetPath);
    expect(() => assertCurrentKnowledgePublication(current.input)).toThrow(/^knowledge_publication_source_unavailable$/);
  });
});
