import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { checkAbort } from '../../infrastructure/providers/dependencies.js';
import type { ContextQuery } from '../../plugin-sdk/capabilities.js';
import type { CandidateStore, PublicationRecord } from './candidate-store.js';
import { canonicalLearningJson, learningDigestSchema } from './requests.js';
import { experienceQueryContextSchema } from './experience-store.js';
import { withKnowledgePublicationLock } from './publication-lock.js';
import { assertKnowledgeCandidate, assertKnowledgeDirectory, assertKnowledgeNavigationReplacement, assertKnowledgePlanUnwritten,
  knowledgeDigest, knowledgeFile, knowledgeTargetDigest,
  planKnowledgePublication, readKnowledgeAuthorization, refreshKnowledgeNavigation, runWikiIngest, verifyKnowledgePlan, withKnowledgePublicationDescriptor, WikiIngestError,
  type KnowledgePlan, type KnowledgePlanningInput, type KnowledgePolicy, type WikiPlan, type WikiResult } from './knowledge.js';

export type PublicationOptions = { store: CandidateStore; policy: KnowledgePolicy; wikiScript: string; recoveryDirectory: string; authorizationFile: string; signal?: AbortSignal };
export type KnowledgeWithdrawal = { key: string; candidateVersion: number; candidateDigest: string; evidenceDigest: string;
  status: 'withdrawn' | 'rollback_blocked'; observedDigest: string; reason: string; recovery?: string };
export type KnowledgePublicationResult = { publication: PublicationRecord; wikiStatus?: WikiResult['status']; recovery?: string; errorCode?: number;
  withdrawal?: KnowledgeWithdrawal };

const publicationOperations = new Map<string, Promise<void>>();

function recoveryDirectory(input: PublicationOptions, key: string, withdrawal = false): string {
  learningDigestSchema.parse(key);
  assertKnowledgeDirectory(input.recoveryDirectory);
  const root = resolve(input.recoveryDirectory);
  const withinVault = relative(resolve(input.policy.vault), root);
  if (withinVault === '' || (withinVault !== '..' && !withinVault.startsWith(`..${sep}`))) throw new Error('Recovery plans must be outside the vault');
  mkdirSync(root, { mode: 0o700, recursive: true });
  const directory = join(root, key, ...(withdrawal ? ['withdrawal'] : []));
  mkdirSync(directory, { mode: 0o700, recursive: true });
  assertKnowledgeDirectory(directory);
  for (const path of [root, join(root, key), directory]) {
    const stats = lstatSync(path);
    if ((process.getuid && stats.uid !== process.getuid()) || (process.platform !== 'win32' && (stats.mode & 0o077))) {
      throw new Error('Recovery directory must be owned and private (0700)');
    }
  }
  return directory;
}

function snapshotFile(input: PublicationOptions, key: string, name = 'plan.json'): string {
  const directory = recoveryDirectory(input, key);
  const file = join(directory, name);
  const inspect = () => {
    const stats = lstatSync(file);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size > 8 * 1024 * 1024
      || (process.getuid && stats.uid !== process.getuid()) || (process.platform !== 'win32' && (stats.mode & 0o077))) {
      throw new Error('Recovery snapshot must be a private regular file');
    }
    return stats;
  };
  let original: ReturnType<typeof inspect>;
  try { original = inspect(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return file; throw error; }
  if (original.nlink !== 1) {
    const temporaryLinks = readdirSync(directory).filter(entry => /^\.receipt-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(entry))
      .map(entry => join(directory, entry)).filter(path => {
        const stats = lstatSync(path);
        return stats.isFile() && !stats.isSymbolicLink() && stats.dev === original.dev && stats.ino === original.ino;
      });
    if (!temporaryLinks.length || original.nlink !== temporaryLinks.length + 1) throw new Error('Recovery snapshot has external hard links');
    for (const [index, path] of temporaryLinks.entries()) {
      const current = inspect();
      const temporary = lstatSync(path);
      if (current.dev !== original.dev || current.ino !== original.ino || current.nlink !== original.nlink - index
        || !temporary.isFile() || temporary.isSymbolicLink() || temporary.dev !== original.dev || temporary.ino !== original.ino) {
        throw new Error('Recovery snapshot links changed during cleanup');
      }
      unlinkSync(path);
    }
    const descriptor = openSync(directory, constants.O_RDONLY);
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    const current = inspect();
    if (current.dev !== original.dev || current.ino !== original.ino || current.nlink !== 1) throw new Error('Recovery snapshot has external hard links');
  }
  return file;
}

function durableReceipt(input: PublicationOptions, key: string, name: string, value: unknown): void {
  checkAbort(input);
  const file = snapshotFile(input, key, name);
  const content = canonicalLearningJson(value);
  const temporary = join(recoveryDirectory(input, key), `.receipt-${randomUUID()}`);
  try {
    const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(descriptor, content); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    linkSync(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (readFileSync(file, 'utf8') !== content) throw new Error('Immutable publication receipt differs');
  } finally {
    try { unlinkSync(temporary); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const directory = openSync(recoveryDirectory(input, key), constants.O_RDONLY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function optionalReceipt(input: PublicationOptions, key: string, name: string): string | undefined {
  try { return readFileSync(snapshotFile(input, key, name), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

function readSnapshot(input: PublicationOptions, publication: PublicationRecord): KnowledgePlan {
  if (publication.recoveryRef !== `wiki:${publication.key}`) throw new Error('Unsupported Wiki recovery reference');
  const prepared = JSON.parse(readFileSync(snapshotFile(input, publication.key), 'utf8')) as KnowledgePlan;
  if (prepared.authorizationFile !== input.authorizationFile || prepared.policyDigest !== knowledgeDigest(input.policy)
    || knowledgeDigest(prepared) !== publication.key || prepared.candidateId !== publication.candidateId
    || prepared.candidateVersion !== publication.candidateVersion || prepared.candidateDigest !== publication.candidateDigest
    || prepared.evidenceDigest !== publication.evidenceDigest || prepared.validatorVersion !== publication.validatorVersion
    || prepared.targetRef !== publication.targetRef || knowledgeTargetDigest(prepared.plan) !== publication.targetDigest
    || knowledgeDigest(prepared.plan.changes.map(change => ({ path: change.path, sha256: change.expected_sha256 }))) !== publication.originalDigest) {
    throw new Error('Wiki recovery snapshot differs from journal receipt');
  }
  return prepared;
}

function supersessionBinding(previous: PublicationRecord, next: PublicationRecord) {
  return { previousKey: previous.key, nextKey: next.key, previousTargetDigest: previous.targetDigest, nextTargetDigest: next.targetDigest };
}

export function resolveKnowledgePublication(input: PublicationOptions & { key: string }): PublicationRecord {
  const visited = new Set<string>();
  let key = input.key;
  for (let depth = 0; depth < 32; depth++) {
    checkAbort(input);
    learningDigestSchema.parse(key);
    if (visited.has(key)) throw new Error('Cyclic publication supersession');
    visited.add(key);
    const publication = input.store.getPublication(key);
    if (!publication) throw new Error('Knowledge publication not found');
    if (publication.phase !== 'superseded') {
      if (publication.supersededBy !== undefined) throw new Error('Unexpected publication successor');
      return publication;
    }
    if (!publication.supersededBy || publication.observedDigest != null || publication.blockedReason
      || optionalReceipt(input, key, 'withdrawal.json')) throw new Error('Invalid superseded publication');
    const prepared = readSnapshot(input, publication);
    if (wikiRecoveryReceipts(input, publication, prepared.plan).length) throw new Error('Superseded publication has recovery writes');
    const next = input.store.getPublication(learningDigestSchema.parse(publication.supersededBy));
    if (!next) throw new Error('Publication successor not found');
    assertKnowledgeNavigationReplacement(prepared, readSnapshot(input, next), input.policy);
    const receipt = optionalReceipt(input, next.key, 'supersession.json');
    if (!receipt || receipt !== canonicalLearningJson(supersessionBinding(publication, next))) {
      throw new Error('Publication supersession receipt differs from journal');
    }
    key = next.key;
  }
  throw new Error('Publication supersession exceeds redirect limit');
}

async function refreshPreparedPublication(input: PublicationOptions, publication: PublicationRecord,
  prepared: KnowledgePlan): Promise<PublicationRecord> {
  if (publication.phase !== 'prepared' || publication.observedDigest != null || publication.blockedReason
    || optionalReceipt(input, publication.key, 'withdrawal.json') || wikiRecoveryReceipts(input, publication, prepared.plan).length) return publication;
  currentCandidate(input, prepared);
  const replacement = await refreshKnowledgeNavigation(prepared, { ...input, candidateId: prepared.candidateId,
    expectedVersion: prepared.candidateVersion, targetRef: prepared.targetRef });
  if (!replacement) return publication;
  const ancestors = input.store.listPublications(publication.candidateId).filter(history => history.phase === 'superseded'
    && history.candidateVersion === publication.candidateVersion);
  if (ancestors.length >= 31) throw new Error('Publication supersession exceeds redirect limit');
  const refreshedPaths = new Set(Object.keys(prepared.readSet).filter(path => prepared.readSet[path] !== replacement.readSet[path]));
  for (const history of input.store.listPublications()) {
    if (history.phase !== 'committed' || !input.policy.targets.some(target => target.ref === history.targetRef)
      || input.store.getCandidate(history.candidateId)?.proposal.applicability.project !== input.policy.scope) continue;
    const committed = readSnapshot(input, history);
    for (const change of committed.plan.changes.slice(1)) {
      if (refreshedPaths.has(change.path)
        && !replacement.plan.changes.find(next => next.path === change.path)?.content.startsWith(change.content)) {
        throw new Error('Navigation replacement cannot remove previously committed navigation');
      }
    }
  }
  const key = knowledgeDigest(replacement);
  if (Buffer.byteLength(canonicalLearningJson(replacement)) > 8 * 1024 * 1024) throw new Error('Recovery snapshot exceeds byte limit');
  const nextInput = { key, validatorVersion: replacement.validatorVersion, targetRef: replacement.targetRef,
    originalDigest: knowledgeDigest(replacement.plan.changes.map(change => ({ path: change.path, sha256: change.expected_sha256 }))),
    targetDigest: knowledgeTargetDigest(replacement.plan), recoveryRef: `wiki:${key}` };
  durableReceipt(input, key, 'plan.json', replacement);
  durableReceipt(input, key, 'supersession.json', supersessionBinding(publication, { ...publication, ...nextInput }));
  currentCandidate(input, prepared);
  assertKnowledgePlanUnwritten(replacement, input.policy);
  if (wikiRecoveryReceipts(input, publication, prepared.plan).length
    || optionalReceipt(input, publication.key, 'withdrawal.json') || optionalReceipt(input, key, 'withdrawal.json')
    || wikiRecoveryReceipts(input, { ...publication, ...nextInput }, replacement.plan).length) throw new Error('Publication changed before supersession');
  checkAbort(input);
  return input.store.supersedePreparedPublication(publication.key, nextInput);
}

function currentCandidate(input: PublicationOptions, prepared: KnowledgePlan): void {
  checkAbort(input);
  readKnowledgeAuthorization(input);
  const publication = input.store.getPublication(knowledgeDigest(prepared));
  if (publication?.phase === 'committed') {
    committedCandidate(input, publication);
    return;
  }
  const candidate = assertKnowledgeCandidate({ ...input, candidateId: prepared.candidateId, expectedVersion: prepared.candidateVersion });
  if (candidate.digest !== prepared.candidateDigest || candidate.evidenceDigest !== prepared.evidenceDigest
    || input.store.getValidation(candidate.id)?.validatorVersion !== prepared.validatorVersion) throw new Error('Publication validation changed');
}

function committedCandidate(input: PublicationOptions, publication: PublicationRecord): void {
  checkAbort(input);
  readKnowledgeAuthorization(input);
  const candidate = input.store.getCandidate(publication.candidateId);
  const source = candidate && input.store.getRequest(candidate.requestKey);
  const receipt = input.store.getValidation(publication.candidateId);
  if (!candidate || candidate.state !== 'published' || candidate.version !== publication.candidateVersion + 1
    || candidate.digest !== publication.candidateDigest || candidate.evidenceDigest !== publication.evidenceDigest
    || !source || source.blockedReason || source.request.evidenceDigest !== publication.evidenceDigest
    || source.request.scope !== input.policy.scope || knowledgeDigest(candidate.proposal) !== publication.candidateDigest
    || !receipt?.passed || receipt.validatedVersion !== publication.candidateVersion
    || receipt.validatorVersion !== publication.validatorVersion || receipt.candidateDigest !== publication.candidateDigest
    || receipt.evidenceDigest !== publication.evidenceDigest) throw new Error('Knowledge source or candidate invalidated');
}

function committedKnowledge(input: PublicationOptions, publication: PublicationRecord, prepared: KnowledgePlan): { path: string; content: string } {
  committedCandidate(input, publication);
  const change = prepared.plan.changes[0]!;
  const content = readFileSync(knowledgeFile(input.policy.vault, change.path), 'utf8');
  if (content !== change.content) throw new Error('Committed knowledge content changed');
  committedCandidate(input, publication);
  return { path: change.path, content };
}

async function withdrawKnowledge(input: PublicationOptions, publication: PublicationRecord, prepared: KnowledgePlan): Promise<KnowledgeWithdrawal> {
  checkAbort(input);
  const binding = { key: publication.key, candidateVersion: publication.candidateVersion,
    candidateDigest: publication.candidateDigest, evidenceDigest: publication.evidenceDigest };
  const change = prepared.plan.changes[0]!;
  const plan: WikiPlan = { version: 1, summary: 'Withdraw invalidated knowledge', evidence: [`Publication ${publication.key}`],
    changes: [{ path: change.path, expected_sha256: createHash('sha256').update(change.content).digest('hex'),
      content: prepared.withdrawalContent }] };
  const intent = { ...binding, vault: input.policy.vault, targetRef: publication.targetRef, plan };
  durableReceipt(input, publication.key, 'withdrawal.json', intent);
  const existing = optionalReceipt(input, publication.key, 'withdrawal-result.json');
  let status: KnowledgeWithdrawal['status'] = 'withdrawn';
  let reason = 'External knowledge absent or withdrawn';
  let recovery: string | undefined;
  try {
    readKnowledgeAuthorization(input, true);
    if (existing) {
      const result = JSON.parse(existing) as KnowledgeWithdrawal;
      if (Object.entries(binding).some(([key, value]) => result[key as keyof KnowledgeWithdrawal] !== value)
        || result.status !== 'withdrawn') throw new Error('Withdrawal receipt differs from publication');
      if (knowledgeTargetDigest(plan, input.policy.vault) === result.observedDigest) return result;
    }
    wikiRecoveryReceipts(input, publication, plan, true);
    const file = knowledgeFile(input.policy.vault, change.path, true);
    let current: string | undefined;
    try { current = readFileSync(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (current !== undefined) {
      const currentHash = createHash('sha256').update(current).digest('hex');
      if (currentHash === change.expected_sha256 && current !== change.content) {
        reason = 'Original knowledge preserved; publication did not replace it';
      } else {
        if (prepared.reused || (current !== change.content && current !== plan.changes[0]!.content)) throw new Error('Human edit or reused knowledge requires manual withdrawal');
        await runWikiIngest(input.wikiScript, input.policy.vault, plan, false, undefined, input.signal);
        readKnowledgeAuthorization(input, true);
        await runWikiIngest(input.wikiScript, input.policy.vault, plan, true, recoveryDirectory(input, publication.key, true), input.signal);
        if (knowledgeTargetDigest(plan, input.policy.vault) !== knowledgeTargetDigest(plan)) throw new Error('External withdrawal target changed');
      }
    }
  } catch (error) {
    checkAbort(input);
    status = 'rollback_blocked';
    reason = error instanceof WikiIngestError ? 'Wiki withdrawal failed; inspect recovery' : 'Withdrawal authorization, rules or target changed; manual review required';
    if (error instanceof WikiIngestError) {
      try {
        const receipts = wikiRecoveryReceipts(input, publication, plan, true);
        recovery = error.recovery && receipts.includes(error.recovery) ? error.recovery : receipts.at(-1);
      } catch { reason = 'Wiki withdrawal recovery receipt could not be verified'; }
    }
  }
  let observedDigest: string;
  try { observedDigest = knowledgeTargetDigest(plan, input.policy.vault); }
  catch { observedDigest = knowledgeDigest({ observation: 'blocked' }); }
  const result: KnowledgeWithdrawal = { ...binding, status, reason, observedDigest, ...(recovery ? { recovery } : {}) };
  durableReceipt(input, publication.key, `withdrawal-outcome-${knowledgeDigest(result)}.json`, result);
  if (status === 'withdrawn' && !existing) durableReceipt(input, publication.key, 'withdrawal-result.json', result);
  return result;
}

async function stopPublication(input: PublicationOptions, publication: PublicationRecord, prepared: KnowledgePlan,
  wikiStatus?: WikiResult['status']): Promise<KnowledgePublicationResult> {
  checkAbort(input);
  if (publication.phase === 'superseded') throw new Error('Cannot withdraw a superseded publication');
  const receipt = publication.phase === 'prepared' || publication.phase === 'applied'
    ? input.store.advancePublication(publication.key, publication.phase === 'prepared' ? 'applied' : 'committed', null) : publication;
  return { publication: receipt, withdrawal: await withdrawKnowledge(input, receipt, prepared), ...(wikiStatus ? { wikiStatus } : {}) };
}

export async function readPublishedKnowledge(input: PublicationOptions & { key: string;
  applicability?: ContextQuery['applicability']; target?: ContextQuery['target'] }): Promise<{ path: string; content: string;
    classification: KnowledgePlan['classification']; applicability: KnowledgePlan['applicability'] } | null> {
  try {
    checkAbort(input);
    if ((input.target && !Object.hasOwn(input, 'target')) || (input.applicability && !Object.hasOwn(input, 'applicability'))) return null;
    const context = experienceQueryContextSchema.safeParse({ applicability: input.applicability, target: input.target });
    if (!context.success) return null;
    const { applicability, target } = context.data;
    const publication = resolveKnowledgePublication(input);
    if (publication.phase !== 'committed' || optionalReceipt(input, publication.key, 'withdrawal.json')) return null;
    const prepared = readSnapshot(input, publication);
    if (target && target.project !== input.policy.scope) return null;
    if (prepared.classification === 'proposal' || prepared.classification === 'unverified' || prepared.classification === 'partial') return null;
    if (prepared.applicability.environments.length && (!applicability?.environment
      || !prepared.applicability.environments.includes(applicability.environment))) return null;
    if (prepared.applicability.versions.length && (!applicability?.version
      || !prepared.applicability.versions.includes(applicability.version))) return null;
    const matchesCondition = (name: string, expected: boolean) => target?.conditions !== undefined
      && Object.hasOwn(target.conditions, name) && target.conditions[name] === expected;
    if (prepared.applicability.preconditions.some(name => !matchesCondition(name, true))
      || prepared.applicability.exclusions.some(name => !matchesCondition(name, false))
      || prepared.applicability.invalidationConditions.some(name => !matchesCondition(name, false))) return null;
    const current = committedKnowledge(input, publication, prepared);
    if (optionalReceipt(input, publication.key, 'withdrawal.json')) return null;
    return { ...current, classification: prepared.classification, applicability: prepared.applicability };
  } catch { checkAbort(input); return null; }
}

function wikiRecoveryReceipts(input: PublicationOptions, publication: PublicationRecord, plan: WikiPlan, withdrawal = false): string[] {
  const directory = recoveryDirectory(input, publication.key, withdrawal);
  return readdirSync(directory).filter(name => name.startsWith('wiki-recovery-')).sort().map(name => {
    const recovery = join(directory, name);
    assertKnowledgeDirectory(recovery);
    const read = (file: string) => {
      assertKnowledgeDirectory(resolve(file, '..'));
      const stats = lstatSync(file);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > 8 * 1024 * 1024) throw new Error('Invalid Wiki recovery file');
      return readFileSync(file);
    };
    const receipt = JSON.parse(read(join(recovery, 'recovery.json')).toString('utf8'));
    if (receipt.vault !== resolve(input.policy.vault) || !Array.isArray(receipt.changes)) throw new Error('Wiki recovery vault differs from authorization');
    for (const change of receipt.changes) {
      const expected = plan.changes.find(entry => entry.path === change.path);
      if (!expected || createHash('sha256').update(expected.content).digest('hex') !== change.after_sha256) throw new Error('Wiki recovery target differs from plan');
      if (change.original === null) {
        if (expected.expected_sha256 !== null) throw new Error('Wiki recovery original missing');
      } else {
        if (typeof change.original !== 'string' || !/^\d+$/.test(change.original)
          || createHash('sha256').update(read(join(recovery, 'originals', change.original))).digest('hex') !== expected.expected_sha256) {
          throw new Error('Wiki recovery original differs from plan');
        }
      }
    }
    return recovery;
  });
}

export async function prepareKnowledgePublication(input: KnowledgePlanningInput & { recoveryDirectory: string }): Promise<PublicationRecord> {
  return publicationOperation(input, () => prepareCandidate(input));
}

async function prepareCandidate(input: KnowledgePlanningInput & { recoveryDirectory: string }): Promise<PublicationRecord> {
  checkAbort(input);
  const unfinished = input.store.listUnfinishedPublications().find(entry => entry.candidateId === input.candidateId);
  if (unfinished) {
    let publication = unfinished;
    let prepared = readSnapshot(input, publication);
    if (input.expectedVersion !== prepared.candidateVersion) throw new Error('Publication candidate version changed');
    if (input.targetRef && input.targetRef !== prepared.targetRef) throw new Error('Publication target differs from prepared plan');
    try {
      currentCandidate(input, prepared);
      publication = await refreshPreparedPublication(input, publication, prepared);
      prepared = readSnapshot(input, publication);
      await verifyKnowledgePlan(prepared, input.policy, input.wikiScript, input.signal);
      currentCandidate(input, prepared);
    } catch (error) { await stopPublication(input, publication, prepared); throw error; }
    return publication;
  }
  const prepared = await planKnowledgePublication(input);
  const key = knowledgeDigest(prepared);
  const content = canonicalLearningJson(prepared);
  if (Buffer.byteLength(content) > 8 * 1024 * 1024) throw new Error('Recovery snapshot exceeds byte limit');
  durableReceipt(input, key, 'plan.json', prepared);
  await verifyKnowledgePlan(prepared, input.policy, input.wikiScript, input.signal);
  currentCandidate(input, prepared);
  return input.store.preparePublication(prepared.candidateId, prepared.candidateVersion, {
    key, validatorVersion: prepared.validatorVersion, targetRef: prepared.targetRef,
    originalDigest: knowledgeDigest(prepared.plan.changes.map(change => ({ path: change.path, sha256: change.expected_sha256 }))),
    targetDigest: knowledgeTargetDigest(prepared.plan), recoveryRef: `wiki:${key}`,
  });
}

export async function publishLearningCandidate(input: PublicationOptions & { key: string }): Promise<KnowledgePublicationResult> {
  return publicationOperation(input, () => publishCandidate(input));
}

async function publicationOperation<Result>(input: Pick<PublicationOptions, 'policy' | 'signal'>, operation: () => Promise<Result>): Promise<Result> {
  checkAbort(input);
  const key = resolve(input.policy.vault);
  const previous = publicationOperations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const completed = new Promise<void>(complete => { release = complete; });
  const current = previous.then(() => completed);
  publicationOperations.set(key, current);
  let onAbort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(input.signal?.reason);
  });
  input.signal?.addEventListener('abort', onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  try {
    await Promise.race([previous, interrupted]);
    return await withKnowledgePublicationLock(key, fd => withKnowledgePublicationDescriptor(key, fd, operation), { signal: input.signal });
  } finally {
    input.signal?.removeEventListener('abort', onAbort);
    release();
    void current.then(() => {
      if (publicationOperations.get(key) === current) publicationOperations.delete(key);
    });
  }
}

async function publishCandidate(input: PublicationOptions & { key: string }): Promise<KnowledgePublicationResult> {
  checkAbort(input);
  let publication = resolveKnowledgePublication(input);
  let prepared = readSnapshot(input, publication);
  if (publication.phase === 'conflict' || optionalReceipt(input, publication.key, 'withdrawal.json')) return stopPublication(input, publication, prepared);
  if (publication.phase === 'committed') {
    try {
      committedKnowledge(input, publication, prepared);
    } catch { return stopPublication(input, publication, prepared); }
    return { publication };
  }
  const conflict = async (wikiStatus?: WikiResult['status']): Promise<KnowledgePublicationResult> => {
    checkAbort(input);
    const current = input.store.getPublication(publication.key)!;
    if (current.phase === 'committed' && !optionalReceipt(input, current.key, 'withdrawal.json')) {
      try {
        committedKnowledge(input, current, prepared);
        return { publication: current, wikiStatus };
      } catch { checkAbort(input); }
    }
    return stopPublication(input, current, prepared, wikiStatus);
  };
  try {
    currentCandidate(input, prepared);
    publication = await refreshPreparedPublication(input, publication, prepared);
    prepared = readSnapshot(input, publication);
    await verifyKnowledgePlan(prepared, input.policy, input.wikiScript, input.signal);
    wikiRecoveryReceipts(input, publication, prepared.plan);
    currentCandidate(input, prepared);
  } catch { return conflict(); }
  let wikiStatus: WikiResult['status'] | undefined;
  if (publication.phase === 'prepared') {
    try {
      const result = await runWikiIngest(input.wikiScript, input.policy.vault, prepared.plan, true, recoveryDirectory(input, publication.key), input.signal);
      wikiStatus = result.status;
    } catch (error) {
      checkAbort(input);
      if (!(error instanceof WikiIngestError)) throw error;
      if (input.store.getPublication(publication.key)?.phase === 'committed') return conflict();
      const receipts = wikiRecoveryReceipts(input, publication, prepared.plan);
      const recovery = error.recovery && receipts.includes(error.recovery) ? error.recovery : receipts.at(-1);
      try {
        currentCandidate(input, prepared);
        await verifyKnowledgePlan(prepared, input.policy, input.wikiScript, input.signal);
        currentCandidate(input, prepared);
      } catch { return { ...await conflict(), recovery, errorCode: error.code }; }
      return { publication: input.store.getPublication(publication.key)!, recovery, errorCode: error.code };
    }
  }
  try {
    await verifyKnowledgePlan(prepared, input.policy, input.wikiScript, input.signal);
    currentCandidate(input, prepared);
  } catch { return conflict(wikiStatus); }
  let receipt = input.store.getPublication(publication.key)!;
  const observed = knowledgeTargetDigest(prepared.plan, input.policy.vault);
  if (receipt.phase === 'prepared') receipt = input.store.advancePublication(publication.key, 'applied', observed);
  if (receipt.phase === 'applied') {
    try {
      await verifyKnowledgePlan(prepared, input.policy, input.wikiScript, input.signal);
      currentCandidate(input, prepared);
    } catch {
      checkAbort(input);
      return stopPublication(input, receipt, prepared, wikiStatus);
    }
    receipt = input.store.advancePublication(publication.key, 'committed', knowledgeTargetDigest(prepared.plan, input.policy.vault));
  }
  if (receipt.phase === 'conflict') return stopPublication(input, receipt, prepared, wikiStatus);
  return { publication: receipt, wikiStatus };
}

export async function reconcileKnowledgePublications(input: PublicationOptions): Promise<{
  results: KnowledgePublicationResult[]; blocked: Array<{ key: string; code: 'publication_recovery_blocked' }>;
}> {
  const results: KnowledgePublicationResult[] = [];
  const blocked: Array<{ key: string; code: 'publication_recovery_blocked' }> = [];
  for (const publication of input.store.listPublications()) {
    const candidate = input.store.getCandidate(publication.candidateId);
    if (!candidate || candidate.proposal.applicability.project !== input.policy.scope
      || !input.policy.targets.some(target => target.ref === publication.targetRef)
      || !['fact', 'process'].includes(candidate.proposal.kind)) continue;
    try {
      if (publication.phase === 'superseded') {
        resolveKnowledgePublication({ ...input, key: publication.key });
        continue;
      }
      const result = await publishLearningCandidate({ ...input, key: publication.key });
      results.push(result);
      if (result.withdrawal?.status === 'rollback_blocked' || result.errorCode !== undefined) {
        blocked.push({ key: publication.key, code: 'publication_recovery_blocked' });
      }
    }
    catch { checkAbort(input); blocked.push({ key: publication.key, code: 'publication_recovery_blocked' }); }
  }
  return { results, blocked };
}
