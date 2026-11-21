import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunEvent } from '@afk/core';
import { JsonlEventStore, verifyRunEventHistory } from '../../infrastructure/observability/jsonl-event-store.js';
import { CandidateStore } from './candidate-store.js';
import { candidateProposalSchema, type CandidateProposal } from './contracts.js';
import { validateEvidencePack } from './evidence.js';
import { request, output } from './ledger-data.fixture.spec.js';
import type { KnowledgePolicy } from './knowledge.js';
import { canonicalLearningJson } from './requests.js';
import { validationConfigurationSchema } from './validation-configuration.js';
import { readValidationPrivateFile } from './validation-files.js';

export const wikiScript = fileURLToPath(new URL('../../../../../skills/wiki/scripts/wiki.py', import.meta.url));
export const hash = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
export const page = (title: string, body: string) => `---\ntags: [knowledge]\nlast_updated: 2026-11-10\n---\n# ${title}\n\n${body}\n`;
const digest = (value: unknown) => hash(canonicalLearningJson(value));

function localAuditSnapshot(root: string, runId: string, workItemId: string) {
  const events = new JsonlEventStore({ root: join(root, 'audit') });
  mkdirSync(events.root, { recursive: true });
  const history: RunEvent[] = [];
  for (const data of [{ kind: 'qa.started' }, { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' }] as const) {
    const event = { id: randomUUID(), schemaVersion: 1 as const, type: data.kind,
      occurredAt: '2026-11-17T00:00:00Z', observedAt: '2026-11-17T00:00:00Z', sequence: history.length + 1,
      context: { runId, workItemId, traceId: 'local-contract', profileId: 'fixture', attempt: 1,
        actor: { kind: 'system' as const, id: 'fixture' } }, correlationId: runId, data,
      integrity: { prevHash: history.at(-1)?.integrity.hash } };
    history.push({ ...event, integrity: { ...event.integrity, hash: digest(event) } } as RunEvent);
  }
  if (!verifyRunEventHistory(runId, history).valid) throw new Error('Invalid synthetic audit history');
  const path = events.pathFor(runId);
  const bytes = history.map(event => JSON.stringify(event)).join('\n') + '\n';
  writeFileSync(path, bytes, { mode: 0o600 });
  const entries = history.map((event, index) => {
    const content = canonicalLearningJson(event);
    const position = { sourceId: 'audit-1', messageIndex: index + 1, line: index + 1, auditSequence: event.sequence };
    const entryDigest = digest({ content, position, completeness: 'complete' });
    return { content, position, ref: { id: `evidence:${entryDigest}`, kind: 'audit', digest: entryDigest,
      locator: `source:audit-1/messages/${index + 1}`, completeness: 'complete', authority: 'observed' } };
  });
  const body = { version: 1, completeness: 'complete', entries, warnings: [],
    sources: [{ id: 'audit-1', kind: 'audit', sourceDigest: hash(bytes), completeness: 'complete', messageCount: history.length }] };
  return { path, root: events.root, history, pack: validateEvidencePack({ ...body, digest: digest(body) }) };
}

export function knowledgeFixture(proposal?: CandidateProposal, factAuthorityPaths?: string[]) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'knowledge-publication-'));
  const vault = join(root, 'vault');
  const recoveryDirectory = join(root, 'recovery');
  mkdirSync(vault);
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(vault, path)), { recursive: true });
    writeFileSync(join(vault, path), content);
  };
  write('AGENTS.md', '# Rules\nUse the template; preserve proposals and evidence gaps.\n');
  write('00-总览.md', page('总览', '[[知识/入口]]'));
  write('知识/入口.md', page('入口', '[[00-总览]]'));
  write('知识/_模板.md', page('{{title}}', '{{knowledge}}'));
  write('99-收件箱/_模板.md', page('{{title}}', '{{knowledge}}'));
  const policy: KnowledgePolicy = {
    scope: request.scope, vault,
    rules: { 'AGENTS.md': hash(readFileSync(join(vault, 'AGENTS.md'))), '.tools/wiki-lint.py': null },
    targets: [{ ref: 'wiki:approval', paths: ['知识/Approval.md'], kinds: ['fact', 'process'], inbox: false,
      templatePath: '知识/_模板.md', indexPaths: ['00-总览.md'], backlinkPaths: ['知识/入口.md'] },
    { ref: 'wiki:inbox', paths: ['99-收件箱/Proposal.md'], kinds: ['fact', 'process'], inbox: true,
      templatePath: '99-收件箱/_模板.md', indexPaths: ['00-总览.md'], backlinkPaths: ['知识/入口.md'] }],
  };
  const store = new CandidateStore({ file: join(root, 'ledger.sqlite') });
  const authorizationFile = join(root, 'knowledge-grant.json');
  const persistGrant = (revoked = false, allowWithdrawal = true) => writeFileSync(authorizationFile,
    JSON.stringify({ version: 1, revoked, allowWithdrawal, policy }), { mode: 0o600 });
  persistGrant();
  const validationVault = join(root, 'validator-vault');
  mkdirSync(validationVault);
  writeFileSync(join(validationVault, 'AGENTS.md'), '# Local synthetic validation contract\n');
  const validationPolicy: KnowledgePolicy = { ...structuredClone(policy), vault: validationVault,
    rules: { 'AGENTS.md': hash(readFileSync(join(validationVault, 'AGENTS.md'))), '.tools/wiki-lint.py': null },
    targets: [...structuredClone(policy.targets), { ...structuredClone(policy.targets[0]!), ref: 'wiki:billing', paths: ['知识/Billing.md'] }] };
  const validationAuthorizationFile = join(root, 'validator-grant.json');
  const validationGrant = { version: 1, revoked: false, allowWithdrawal: true, policy: validationPolicy };
  writeFileSync(validationAuthorizationFile, JSON.stringify(validationGrant), { mode: 0o600 });
  const oracleRoot = join(root, 'oracle');
  mkdirSync(oracleRoot);
  const validationTargetPath = join(oracleRoot, 'approval.json');
  writeFileSync(validationTargetPath, '{"approvalRequired":true}\n');
  const validationConfigurationFile = join(root, 'validation-checkers.json');
  const selectedTarget = proposal?.targetRef ?? 'wiki:approval';
  const validationTargets = [...validationPolicy.targets].sort((left, right) =>
    Number(right.ref === selectedTarget) - Number(left.ref === selectedTarget));
  const checkers = validationTargets.map((target, index) => ({ scope: request.scope, checkerId: `local-checker-${index}`,
    providerId: 'local-synthetic-contract', version: '1', authorizationFile: validationAuthorizationFile,
    target: { ref: target.ref, root: oracleRoot, path: 'approval.json' }, factAuthorityPaths }));
  writeFileSync(validationConfigurationFile, JSON.stringify(validationConfigurationSchema.parse({ version: 1, checkers })), { mode: 0o600 });
  const addCandidate = (input: CandidateProposal, identity = { runId: 'billing', workItemId: 'github:acme/api#43' }) => {
    const source = localAuditSnapshot(root, identity.runId, identity.workItemId);
    const refs = source.pack.entries.map(entry => entry.ref);
    const remap = (ids: readonly string[]) => ids.map(id => id === 'e1' || id === candidateEvidenceId ? refs[0]!.id : id);
    const candidateProposal = candidateProposalSchema.parse({ ...input, evidenceIds: remap(input.evidenceIds),
      ...(input.kind === 'process' ? { payload: { ...input.payload,
        steps: input.payload.steps.map(step => ({ ...step, evidenceIds: remap(step.evidenceIds) })) } } : {}) });
    const analyzerVersion = 'local-contract';
    const submission = { request: { ...request, sourceId: `run:${identity.runId}`, sourceRunId: identity.runId,
      workItemId: identity.workItemId, evidenceDigest: source.pack.digest, analyzerVersion }, evidence: refs };
    const stored = candidateProposal.kind === 'lesson' ? store.submitRequest(submission) : store.commitScan({
      scope: request.scope, runId: identity.runId, analyzerVersion, sourceRoot: source.root,
      expectedCursor: null, cursor: { sequence: source.history.length, head: source.history.at(-1)!.integrity.hash },
      requests: [submission] }, [source.pack])[0]!;
    const completed = store.completeRequest(stored.key, { version: 1, candidates: [candidateProposal], warnings: [] });
    const original = store.getCandidate(completed.candidateIds[0]!)!;
    const checker = checkers.find(entry => entry.target.ref === candidateProposal.targetRef) ?? checkers[0]!;
    const targetDigest = hash(readFileSync(validationTargetPath));
    const configurationDigest = readValidationPrivateFile(validationConfigurationFile).fingerprint;
    const binding = { scope: request.scope, candidateId: original.id, candidateVersion: original.version,
      candidateDigest: original.digest, evidenceDigest: original.evidenceDigest, checkerId: checker.checkerId,
      checkerVersion: checker.version, configurationDigest,
      authorizationDigest: digest([configurationDigest, readValidationPrivateFile(validationAuthorizationFile).fingerprint, validationGrant]),
      executionId: randomUUID(), target: { scope: request.scope, ref: checker.target.ref,
        revision: `sha256:${targetDigest}`, snapshotDigest: targetDigest } };
    const assertions: Array<{ node: string; expected: string | string[]; actual: string | string[]; status: 'observed';
      evidence: Array<{ id: string; digest: string; locator: string }> }> = [];
    const add = (node: string, expected: string | string[], ids = candidateProposal.evidenceIds) => {
      if (!ids.length) return;
      assertions.push({ node, expected, actual: expected, status: 'observed', evidence: ids.map(id => {
        const ref = refs.find(entry => entry.id === id);
        if (!ref) throw new Error('Unknown synthetic knowledge evidence');
        return { id: ref.id, digest: ref.digest, locator: ref.locator };
      }) });
    };
    if (candidateProposal.kind === 'fact') {
      add('fact.subject', candidateProposal.payload.subject);
      add('fact.rule', candidateProposal.payload.rule);
      add('fact.authority', candidateProposal.evidenceIds.map(id => refs.find(ref => ref.id === id)!.locator).sort());
    } else if (candidateProposal.kind === 'process') {
      add('process.entry', candidateProposal.payload.entry);
      for (const field of ['preconditions', 'exclusions', 'invalidationConditions'] as const) add(`process.applicability.${field}`, candidateProposal.applicability[field]);
      add('process.systems', candidateProposal.payload.systems);
      add('process.preconditions', candidateProposal.payload.preconditions);
      add('process.stepCount', String(candidateProposal.payload.steps.length));
      candidateProposal.payload.steps.forEach((step, index) => {
        add(`process.steps.${index}.action`, step.action, step.evidenceIds);
        add(`process.steps.${index}.stateChange`, step.stateChange, step.evidenceIds);
      });
      add('process.exceptions', candidateProposal.payload.exceptions);
      add('process.completion', candidateProposal.payload.completion);
    }
    const report = { protocol: 'learning-validation-v1', binding, assertions };
    const encoded = Buffer.from(canonicalLearningJson({ report, receiptDigest: digest(report) })).toString('base64');
    return store.recordValidation(original.id, original.version, { candidateDigest: original.digest, evidenceDigest: original.evidenceDigest,
      validatorVersion: `learning-validation-v1:${binding.executionId}`, passed: true,
      results: encoded.match(/.{1,1800}/g)!.map(chunk => `json-base64-v1:${chunk}`) });
  };
  let candidateEvidenceId: string | undefined;
  const candidate = addCandidate(proposal ?? candidateProposalSchema.parse({ ...output.candidates[0], targetRef: 'wiki:approval' }),
    { runId: request.sourceRunId, workItemId: request.workItemId });
  candidateEvidenceId = candidate.proposal.evidenceIds[0];
  const evidenceSourcePath = new JsonlEventStore({ root: join(root, 'audit') }).pathFor(request.sourceRunId);
  return { root, vault, recoveryDirectory, policy, store, candidate, wikiScript, write, authorizationFile, persistGrant,
    validationConfigurationFile, validationAuthorizationFile, validationTargetPath, evidenceSourcePath, addCandidate,
    input: { store, candidateId: candidate.id, expectedVersion: candidate.version, policy, wikiScript, recoveryDirectory, authorizationFile,
      validationConfigurationFile },
    cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
