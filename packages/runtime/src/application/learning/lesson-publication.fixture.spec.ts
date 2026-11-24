import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RunEvent, RunEventData } from '@afk/core';
import { expect, vi } from 'vitest';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import type { VerificationProvider } from '../../plugin-sdk/capabilities.js';
import { CandidateStore } from './candidate-store.js';
import { completeFixtureRequest } from './ledger-data.fixture.spec.js';
import { buildEvidencePack } from './evidence.js';
import { canonicalLearningJson } from './requests.js';
import { validateConfiguredLearningCandidate } from './validation-runtime.js';
import type { CandidateProposal } from './contracts.js';
import type { readKnowledgeGrant } from './knowledge.js';

const scope = 'github:acme/lesson';
const workItemId = `${scope}#19`;
const revision = 'a'.repeat(40);
const bytesDigest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => bytesDigest(canonicalLearningJson(value));

export interface LessonPublicationFixtureOptions {
  registerCleanup(cleanup: () => void): void;
  analysisCallId?: string;
  versions?: string[];
  triggerAliases?: string[];
  lessonFix?: string;
  managed?: boolean;
  repair?: boolean;
  includeFact?: boolean;
  targetDirectory?: string;
  configurationVersion?: 1 | 2;
  additionalCheckers?: readonly unknown[];
  homeStorage?: boolean;
  homeDir?: string;
  applicability?: Partial<Pick<Extract<CandidateProposal, { kind: 'lesson' }>['applicability'], 'productId' | 'environments' | 'preconditions' | 'exclusions' | 'invalidationConditions'>>;
}

export async function createLessonPublicationFixture(options: LessonPublicationFixtureOptions) {
  const { registerCleanup, managed = false, versions = [], includeFact = false, targetDirectory, configurationVersion = 1 } = options;
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'lesson-publication-guard-'));
  registerCleanup(() => rmSync(root, { recursive: true, force: true }));
  const file = options.homeStorage ? join(root, '.afk', 'learning', 'candidates.sqlite') : join(root, 'ledger', 'candidates.sqlite');
  const store = new CandidateStore({ file });
  registerCleanup(() => store.close());
  const events = new JsonlEventStore({ root: join(root, 'audit') });
  const append = async (runId: string, data: RunEventData[]) => events.append(data.map((entry, index) => ({
    id: `${runId}-${index}-${entry.kind}`, schemaVersion: 1 as const, type: entry.kind,
    occurredAt: '2026-11-11T00:00:00Z', context: { runId, workItemId, traceId: runId, profileId: 'fixture', attempt: 1,
      actor: { kind: 'system' as const, id: 'runtime' } }, correlationId: runId, data: entry,
  })));
  const transcript = join(options.homeDir ?? root, '.codex', 'sessions', 'source.jsonl');
  if (managed) {
    if (!options.homeDir) vi.stubEnv('HOME', root);
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: 'Retry repair observation' } }) + '\n');
    await append('original-failure', [{ kind: 'qa.started' }, { kind: 'agent.session_recorded', sessionId: 'source-session', transcriptPath: transcript },
      ...(options.repair ? [{ kind: 'qa.failed' as const, reason: 'Duplicate retry race' }] : [{ kind: 'qa.passed' as const }]),
      { kind: 'run.finished', outcome: options.repair ? 'failed' : 'succeeded' }]);
  } else await append('original-failure', [{ kind: 'qa.failed', reason: ['Duplicate retry race', ...(options.triggerAliases ?? [])].join('; ') },
    ...(options.repair ? [{ kind: 'run.finished' as const, outcome: 'failed' as const }] : [])]);
  const sourceInput = { id: 'audit-1', kind: 'audit' as const, path: events.pathFor('original-failure'),
    allowedRoot: events.root, runId: 'original-failure' };
  const pack = await buildEvidencePack({ sources: [sourceInput, ...(managed
    ? [{ id: 'session-1', kind: 'session' as const, path: transcript, allowedRoot: dirname(transcript) }] : [])] });
  const payload = { trigger: 'duplicate retry', rootCause: 'check then write race', rootCauseStatus: 'confirmed' as const,
    ...(options.triggerAliases ? { triggerAliases: options.triggerAliases } : {}),
    attempts: ['unserialized retry failed'], fix: options.lessonFix ?? 'Serialize retry read and write', prevention: ['Competing retry regression'] };
  const submission = { request: { version: 1 as const, scope, workItemId, sourceId: 'original-failure', sourceRunId: 'original-failure',
    evidenceDigest: pack.digest, analyzerVersion: 'fixture', reason: 'repaired' as const }, evidence: pack.entries.map(entry => entry.ref) };
  const history: RunEvent[] = readFileSync(sourceInput.path, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  const source = managed ? store.commitScan({ scope, runId: 'original-failure', analyzerVersion: 'fixture', sourceRoot: events.root,
    expectedCursor: null, cursor: { sequence: history.length, head: history.at(-1)!.integrity.hash }, requests: [submission] }, [pack])[0]
    : store.submitRequest(submission, pack);
  const processed = completeFixtureRequest(store, source.key, { version: 1, warnings: [], candidates: [{ kind: 'lesson', title: 'Retry race',
    statement: 'Serialize retries', targetRef: 'wiki:retry', evidenceIds: [pack.entries[0].ref.id], payload,
    applicability: { project: scope, environments: [], versions, preconditions: [], exclusions: [], invalidationConditions: [], ...options.applicability } },
  ...(includeFact ? [{ kind: 'fact', title: 'Retry serialization', statement: 'Retry read and write share a serialization boundary',
    targetRef: 'wiki:retry', evidenceIds: [pack.entries[0].ref.id],
    payload: { subject: 'Retry transaction', rule: 'Read and write share a serialization boundary', classification: 'fact' },
    applicability: { project: scope, environments: [], versions, preconditions: [], exclusions: [], invalidationConditions: [] } }] : [])] }, options.analysisCallId);
  const candidateId = processed.candidateIds[0];
  await append('independent-qa', [{ kind: 'qa.started' }, { kind: 'decision.made', command: 'experience.qa-target', accepted: true,
    reason: JSON.stringify({ target: { project: scope, revision, dirty: false } }) }, { kind: 'qa.passed' },
  { kind: 'commit.recorded', phase: 'qa', branch: 'qa', commitSha: revision }, { kind: 'run.finished', outcome: 'succeeded' }]);
  const qaPath = events.pathFor('independent-qa');
  if (options.repair) await append('repair-run', [
    { kind: 'commit.recorded', phase: 'implementation', commitSha: revision, branch: 'repair' },
    { kind: 'run.finished', outcome: 'succeeded' },
  ]);
  const vault = join(root, 'vault');
  mkdirSync(vault);
  if (targetDirectory) mkdirSync(join(vault, targetDirectory), { recursive: true });
  writeFileSync(join(vault, 'AGENTS.md'), '# Temporary fixture\n');
  writeFileSync(join(vault, 'template.md'), '{{title}}\n{{knowledge}}');
  const authorizationFile = join(root, 'grant.json');
  const grant: ReturnType<typeof readKnowledgeGrant> = { version: 1, revoked: false, allowWithdrawal: true, policy: { scope, vault,
    rules: { 'AGENTS.md': bytesDigest(readFileSync(join(vault, 'AGENTS.md'))), '.tools/wiki-lint.py': null }, targets: [{ ref: 'wiki:retry', kinds: ['fact', 'process', 'lesson'],
      paths: [targetDirectory ? `${targetDirectory}/Retry.md` : 'Retry.md'], inbox: false, templatePath: 'template.md',
      indexPaths: ['index.md'], backlinkPaths: ['backlinks.md'] }] } };
  const persistGrant = () => writeFileSync(authorizationFile, JSON.stringify(grant), { mode: 0o600 });
  persistGrant();
  const oracle = join(root, 'oracle.json');
  const values = Object.fromEntries(Object.entries({ ...payload, project: scope, environments: options.applicability?.environments ?? [], versions,
    productId: options.applicability?.productId,
    applicabilityPreconditions: options.applicability?.preconditions ?? [], exclusions: options.applicability?.exclusions ?? [],
    invalidationConditions: options.applicability?.invalidationConditions ?? [], fixTargetRevision: revision }).map(([key, value]) => [`lesson.${key}`, value]));
  writeFileSync(oracle, JSON.stringify(values));
  const configurationFile = join(root, 'checkers.json');
  const configuration = { version: configurationVersion, checkers: [{ ...(configurationVersion === 2 ? { mode: 'knowledge' as const } : {}),
    scope, checkerId: 'lesson-checker', providerId: 'semantic-lesson', version: '1',
    authorizationFile, allowLessonValidation: true, target: { ref: 'wiki:retry', root, path: 'oracle.json' },
    qa: { scope, workItemId, runId: 'independent-qa', targetRevision: revision, root: events.root, auditDigest: bytesDigest(readFileSync(qaPath)),
      ...(options.repair ? { repair: {
        failure: { runId: 'original-failure', root: events.root, auditDigest: bytesDigest(readFileSync(sourceInput.path)) },
        fix: { runId: 'repair-run', root: events.root, auditDigest: bytesDigest(readFileSync(events.pathFor('repair-run'))) },
      } } : {}) },
    ...(managed ? {} : { evidence: [{ digest: pack.digest, sources: [sourceInput] }] }) }] };
  const persistConfiguration = () => writeFileSync(configurationFile, JSON.stringify({ ...configuration,
    checkers: [...configuration.checkers, ...(options.additionalCheckers ?? [])] }), { mode: 0o600 });
  persistConfiguration();
  const provider: VerificationProvider = { id: 'semantic-lesson', capabilities: { 'test-execution': true, 'static-analysis': false, 'custom-script': false },
    doctor: async () => [{ check: 'learning-validation-v1', ok: true, detail: JSON.stringify({ scope, checkerId: 'lesson-checker',
      providerId: 'semantic-lesson', version: '1' }) }],
    verify: vi.fn(async request => {
      const envelope = JSON.parse(request.target);
      const observations = JSON.parse(readFileSync(oracle, 'utf8'));
      return { passed: true, durationMs: 1, output: JSON.stringify({ protocol: envelope.protocol, binding: envelope.binding,
        assertions: envelope.assertions.map((assertion: { node: string }) => ({ ...assertion, actual: observations[assertion.node], status: 'observed' })) }) };
    }) };
  const result = await validateConfiguredLearningCandidate({ scope, candidateId, expectedVersion: 1, checkerId: 'lesson-checker' },
    { file, configurationFile, homeDir: options.homeDir, resolveProvider: async () => provider });
  expect(result.status, JSON.stringify(result)).toBe('validated');
  const candidate = store.getCandidate(candidateId)!;
  expect(candidate).toMatchObject({ state: 'validated', version: 2 });
  const input = { store, candidate, configurationFile };
  const receipt = store.getValidation(candidateId)!;
  const decode = () => JSON.parse(Buffer.from(receipt.results.map(chunk => chunk.slice('json-base64-v1:'.length)).join(''), 'base64').toString('utf8'));
  const rewrite = (change: (value: ReturnType<typeof decode>) => void) => {
    const envelope = decode();
    change(envelope);
    envelope.receiptDigest = digest(envelope.report);
    const results = Buffer.from(canonicalLearningJson(envelope)).toString('base64').match(/.{1,1800}/g)!.map(chunk => `json-base64-v1:${chunk}`);
    vi.spyOn(store, 'getValidation').mockReturnValue({ ...receipt, results });
  };
  return { root, file, vault, scope, workItemId, revision, candidateIds: processed.candidateIds, store, input, source, pack, candidate, receipt, decode, rewrite, provider, configuration, configurationFile,
    persistConfiguration, grant, persistGrant, authorizationFile, oracle, qaPath, append, events, sourceInput, transcript };
}
