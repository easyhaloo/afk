import { createHash } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { TokenUsage } from '../../domain/agents/types.js';
import { openSqlite, transaction, type SqliteDatabase } from '../../infrastructure/storage/sqlite.js';
import { assertCandidateTransition, candidateStateSchema, DISTILLATION_LIMITS, learningScopeSchema,
  parseDistillationOutput, type CandidateProposal, type CandidateState } from './contracts.js';
import { blockedReasonSchema, canonicalLearningJson, learningDigestSchema, learningIdentitySchema,
  prepareDistillationRequest, type DistillationSubmission, type PreparedDistillationRequest } from './requests.js';

const schema = `CREATE TABLE learning_ledger (
  kind TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes > 0), PRIMARY KEY(kind, key)
) STRICT, WITHOUT ROWID;`;
const cursorSchema = z.object({ sequence: z.number().int().nonnegative().safe(), head: learningDigestSchema }).strict();
const scanIdentitySchema = z.object({ scope: learningScopeSchema, runId: learningIdentitySchema, analyzerVersion: learningIdentitySchema }).strict();
const scanSchema = scanIdentitySchema.extend({ expectedCursor: cursorSchema.nullable(), cursor: cursorSchema,
  requests: z.array(z.unknown()).max(DISTILLATION_LIMITS.pendingRequests) }).strict();
const logicalRef = learningIdentitySchema.refine(value => /^[a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
  && !value.split(/[/:]/).some(part => part === '.' || part === '..'), 'Expected logical reference');
const validationSchema = z.object({ candidateDigest: learningDigestSchema, evidenceDigest: learningDigestSchema,
  validatorVersion: learningIdentitySchema, passed: z.boolean(), results: z.array(blockedReasonSchema).min(1).max(32) }).strict();
const publicationSchema = z.object({ key: learningIdentitySchema, validatorVersion: learningIdentitySchema,
  targetRef: logicalRef, originalDigest: learningDigestSchema.nullable(), targetDigest: learningDigestSchema,
  recoveryRef: logicalRef }).strict();
const versionSchema = z.number().int().positive().safe();
const utcDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Expected a valid UTC calendar day');
const modelCallSchema = z.object({ day: utcDaySchema, callId: learningIdentitySchema,
  limit: z.number().int().nonnegative().safe() }).strict();
const analysisStartSchema = modelCallSchema.extend({ requestKey: learningDigestSchema,
  startedAt: z.string().datetime({ offset: true }) }).strict();
const analysisIdentitySchema = z.object({ analysisRunId: learningIdentitySchema, sessionId: learningIdentitySchema }).strict();
const usageCounterSchema = z.number().int().nonnegative().safe();
const analysisUsageSchema = z.object({ inputTokens: usageCounterSchema.optional(), outputTokens: usageCounterSchema.optional(),
  totalTokens: usageCounterSchema.optional() }).strict().refine(usage => Object.values(usage).some(value => value !== undefined),
  'Expected at least one known usage counter');
const analysisResultSchema = z.object({ status: z.enum(['succeeded', 'failed', 'cancelled']),
  finishedAt: z.string().datetime({ offset: true }), errorCode: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/).optional(),
  usage: analysisUsageSchema.optional() }).strict();
const limitsSchema = z.object({
  pendingRequests: z.number().int().positive().max(DISTILLATION_LIMITS.pendingRequests).default(DISTILLATION_LIMITS.pendingRequests),
  pendingBytes: z.number().int().positive().max(DISTILLATION_LIMITS.pendingBytes).default(DISTILLATION_LIMITS.pendingBytes),
  records: z.number().int().positive().max(DISTILLATION_LIMITS.records).default(DISTILLATION_LIMITS.records),
  recordBytes: z.number().int().positive().max(DISTILLATION_LIMITS.recordBytes).default(DISTILLATION_LIMITS.recordBytes),
}).strict();

export interface CandidateStoreOptions { file: string; limits?: Partial<z.infer<typeof limitsSchema>> }
export type ScanCursor = z.infer<typeof cursorSchema>;
export type ScanIdentity = z.infer<typeof scanIdentitySchema>;
export interface ScanSubmission extends ScanIdentity {
  expectedCursor: ScanCursor | null; cursor: ScanCursor; requests: DistillationSubmission[];
}
export interface HandoffReceipt { requestKey: string; deliveryKey: string }
export interface StoredDistillationRequest extends PreparedDistillationRequest { handoff?: HandoffReceipt }
export interface ProcessingReceipt { requestKey: string; outputDigest: string; candidateIds: string[]; warnings: string[] }
export type ModelCallInput = z.infer<typeof modelCallSchema>;
export interface ModelCallReservation { day: string; callId: string; ordinal: number }
export type StartAnalysisAttemptInput = z.infer<typeof analysisStartSchema>;
export type AnalysisIdentity = z.infer<typeof analysisIdentitySchema>;
export type AnalysisAttemptResult = z.infer<typeof analysisResultSchema>;
export interface AnalysisAttempt {
  requestKey: string; callId: string; day: string; startedAt: string; ownerPid: number; host: string;
  status: 'started' | AnalysisAttemptResult['status']; analysisRunId?: string; sessionId?: string;
  finishedAt?: string; errorCode?: string; usage?: Partial<TokenUsage>;
}
export interface LearningCandidate {
  id: string; requestKey: string; version: number; state: CandidateState;
  digest: string; evidenceDigest: string; proposal: CandidateProposal;
}
export type CandidateValidation = z.infer<typeof validationSchema>;
export interface ValidationReceipt extends CandidateValidation { candidateId: string; candidateVersion: number; validatedVersion: number }
export type PublicationInput = z.infer<typeof publicationSchema>;
export interface PublicationRecord extends PublicationInput {
  candidateId: string; candidateVersion: number; candidateDigest: string; evidenceDigest: string;
  phase: 'prepared' | 'applied' | 'committed' | 'conflict'; observedDigest?: string | null; blockedReason?: string;
}

function digest(input: unknown): string {
  return createHash('sha256').update(canonicalLearningJson(input)).digest('hex');
}

function privateFile(file: string, repairPermissions = false): void {
  try {
    const stats = lstatSync(file);
    if (stats.isSymbolicLink()) throw new Error('Learning ledger refuses symbolic links');
    if (!stats.isFile() || stats.nlink !== 1 || (process.getuid && stats.uid !== process.getuid())) throw new Error('Learning ledger requires an owned regular private file');
    if (!repairPermissions) {
      if (process.platform !== 'win32' && (stats.mode & 0o077)) throw new Error('Learning ledger file permissions must be private (0600)');
      return;
    }
    const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(descriptor);
      if (opened.ino !== stats.ino || opened.dev !== stats.dev) throw new Error('Learning ledger private file changed during open');
      if (process.platform !== 'win32') fchmodSync(descriptor, 0o600);
    } finally { closeSync(descriptor); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function privatePath(file: string): string {
  if (!isAbsolute(file) || file.includes('\0')) throw new Error('Learning ledger requires an absolute private file path');
  const absolute = resolve(file);
  let current = parse(absolute).root;
  for (const segment of relative(current, dirname(absolute)).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try { mkdirSync(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stats = lstatSync(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('Learning ledger refuses symbolic link directories');
  }
  if (realpathSync(dirname(absolute)) !== dirname(absolute)) throw new Error('Learning ledger refuses symbolic link parents');
  const parent = lstatSync(dirname(absolute));
  if ((process.getuid && parent.uid !== process.getuid()) || (process.platform !== 'win32' && (parent.mode & 0o077))) {
    throw new Error('Learning ledger parent directory must be owned and private (0700)');
  }
  for (const path of [absolute, `${absolute}-wal`, `${absolute}-shm`, `${absolute}-journal`]) privateFile(path, true);
  try {
    const descriptor = openSync(absolute, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    closeSync(descriptor);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  privateFile(absolute, true);
  return absolute;
}

export class CandidateStore {
  private readonly database: SqliteDatabase;
  private readonly limits: z.infer<typeof limitsSchema>;
  private readonly file: string;
  private readonly fileIdentity: { dev: number; ino: number };
  private closed = false;

  constructor(options: CandidateStoreOptions) {
    this.limits = limitsSchema.parse(options.limits ?? {});
    this.file = privatePath(z.string().min(1).parse(options.file));
    this.fileIdentity = lstatSync(this.file);
    this.database = openSqlite({ file: this.file, schema, durability: 'FULL', version: 1,
      initialize: database => { database.prepare('SELECT kind, key, payload, bytes FROM learning_ledger LIMIT 1').all(); } });
    try {
      const pageSize = Number(this.database.prepare('PRAGMA page_size').get()?.page_size);
      this.database.exec(`PRAGMA max_page_count = ${Math.floor(64 * 1024 * 1024 / pageSize)}; PRAGMA journal_size_limit = 1048576; PRAGMA wal_autocheckpoint = 128;`);
      this.secureFiles();
    }
    catch (error) { this.database.close(); throw error; }
  }

  reserveModelCall(input: ModelCallInput): ModelCallReservation {
    const parsed = modelCallSchema.parse(input);
    return this.write(() => this.reserveModelCallInTransaction(parsed));
  }

  startAnalysisAttempt(input: StartAnalysisAttemptInput): AnalysisAttempt {
    const parsed = analysisStartSchema.parse(input);
    return this.write(() => {
      this.requireRequest(parsed.requestKey);
      const existing = this.read<AnalysisAttempt>('analysis-attempt', parsed.callId);
      if (existing && (existing.requestKey !== parsed.requestKey || existing.day !== parsed.day || existing.startedAt !== parsed.startedAt)) {
        throw new Error('Learning analysis attempt: same callId has conflicting content');
      }
      this.reserveModelCallInTransaction(parsed);
      if (existing) return existing;
      const attempt: AnalysisAttempt = { requestKey: parsed.requestKey, callId: parsed.callId, day: parsed.day,
        startedAt: parsed.startedAt, ownerPid: process.pid, host: hostname(), status: 'started' };
      this.put('analysis-attempt', parsed.callId, attempt);
      return attempt;
    });
  }

  recordAnalysisIdentity(callId: string, identity: AnalysisIdentity): AnalysisAttempt {
    const key = learningIdentitySchema.parse(callId);
    const parsed = analysisIdentitySchema.parse(identity);
    return this.write(() => {
      const current = this.requireAnalysisAttempt(key);
      if (current.analysisRunId !== undefined || current.sessionId !== undefined) {
        if (current.analysisRunId !== parsed.analysisRunId || current.sessionId !== parsed.sessionId) {
          throw new Error('Learning analysis attempt identity cannot be replaced');
        }
        return current;
      }
      const attempt = { ...current, ...parsed };
      this.put('analysis-attempt', key, attempt);
      return attempt;
    });
  }

  finishAnalysisAttempt(callId: string, result: AnalysisAttemptResult): AnalysisAttempt {
    const key = learningIdentitySchema.parse(callId);
    const parsed = analysisResultSchema.parse(result);
    const terminal: AnalysisAttemptResult = { status: parsed.status, finishedAt: parsed.finishedAt };
    if (parsed.errorCode !== undefined) terminal.errorCode = parsed.errorCode;
    if (parsed.usage !== undefined) {
      terminal.usage = Object.fromEntries(Object.entries(parsed.usage).filter(([, value]) => value !== undefined));
    }
    return this.write(() => {
      const current = this.requireAnalysisAttempt(key);
      if (Date.parse(terminal.finishedAt) < Date.parse(current.startedAt)) throw new Error('Learning analysis attempt finishedAt precedes startedAt');
      if (current.status !== 'started') {
        const existing = { status: current.status, finishedAt: current.finishedAt, errorCode: current.errorCode, usage: current.usage };
        if (canonicalLearningJson(existing) !== canonicalLearningJson(terminal)) {
          throw new Error('Learning analysis attempt has conflicting terminal content');
        }
        return current;
      }
      const attempt = { ...current, ...terminal };
      this.put('analysis-attempt', key, attempt);
      return attempt;
    });
  }

  listAnalysisAttempts(requestKey?: string): AnalysisAttempt[] {
    const key = requestKey === undefined ? undefined : learningDigestSchema.parse(requestKey);
    return this.all<AnalysisAttempt>('analysis-attempt').filter(attempt => key === undefined || attempt.requestKey === key);
  }

  getModelCallCount(day: string): number {
    utcDaySchema.parse(day);
    this.assertOpen();
    return Number(this.database.prepare("SELECT COUNT(*) AS count FROM learning_ledger WHERE kind = 'model-call' AND json_extract(payload, '$.day') = ?").get(day)!.count);
  }

  submitRequest(input: DistillationSubmission): StoredDistillationRequest {
    const prepared = prepareDistillationRequest(input);
    return this.write(() => { this.insertRequest(prepared); return this.getRequest(prepared.key)!; });
  }

  getRequest(key: string): StoredDistillationRequest | undefined {
    const request = this.read<PreparedDistillationRequest>('request', learningDigestSchema.parse(key));
    if (!request) return undefined;
    const blocking = this.read<{ reason: string | null }>('blocking', key);
    if (blocking) {
      delete request.blockedReason;
      if (blocking.reason !== null) request.blockedReason = blocking.reason;
    }
    return { ...request, handoff: this.read<HandoffReceipt>('handoff', key) };
  }

  listPendingRequests(): StoredDistillationRequest[] {
    return this.all<PreparedDistillationRequest>('request').map(entry => this.getRequest(entry.key)!)
      .filter(entry => !entry.handoff && !entry.blockedReason && !this.getProcessingReceipt(entry.key));
  }

  listRequests(): StoredDistillationRequest[] {
    return this.all<PreparedDistillationRequest>('request').map(entry => this.getRequest(entry.key)!);
  }

  setRequestBlocked(key: string, reason: string | null): void {
    const parsed = reason === null ? null : blockedReasonSchema.parse(reason);
    this.write(() => {
      this.requireRequest(key);
      this.put('blocking', key, { reason: parsed });
    });
  }

  markHandedOff(key: string, deliveryKey: string): HandoffReceipt {
    const receipt = { requestKey: learningDigestSchema.parse(key), deliveryKey: learningIdentitySchema.parse(deliveryKey) };
    return this.write(() => { this.requireRequest(key); return this.insertImmutable('handoff', key, receipt); });
  }

  getScanCursor(input: ScanIdentity): ScanCursor | undefined {
    const identity = scanIdentitySchema.parse({ scope: input.scope, runId: input.runId, analyzerVersion: input.analyzerVersion });
    return this.read('cursor', digest(identity));
  }

  commitScan(input: ScanSubmission): StoredDistillationRequest[] {
    const parsed = scanSchema.parse(input);
    const identity = { scope: parsed.scope, runId: parsed.runId, analyzerVersion: parsed.analyzerVersion };
    const requests = parsed.requests.map(entry => prepareDistillationRequest(entry as DistillationSubmission));
    if (requests.some(entry => entry.request.sourceRunId !== identity.runId || entry.request.scope !== identity.scope
      || entry.request.analyzerVersion !== identity.analyzerVersion)) throw new Error('Scan request differs from run, scope or analyzer version');
    return this.write(() => {
      const current = this.getScanCursor(identity) ?? null;
      if (canonicalLearningJson(current) !== canonicalLearningJson(parsed.expectedCursor)) throw new Error('Scan cursor version conflict');
      if (current && parsed.cursor.sequence <= current.sequence) throw new Error('Scan cursor must advance');
      for (const entry of requests) this.insertRequest(entry);
      this.put('cursor', digest(identity), parsed.cursor);
      return requests.map(entry => this.getRequest(entry.key)!);
    });
  }

  getProcessingReceipt(key: string): ProcessingReceipt | undefined {
    return this.read('processing', learningDigestSchema.parse(key));
  }

  completeRequest(key: string, modelOutput: unknown): ProcessingReceipt {
    return this.write(() => {
      const source = this.requireRequest(key);
      if (source.blockedReason) throw new Error(`Learning request blocked: ${source.blockedReason}`);
      const output = parseDistillationOutput(modelOutput, source.request, source.evidence);
      const outputDigest = digest(output);
      const existing = this.getProcessingReceipt(key);
      if (existing) {
        if (existing.outputDigest !== outputDigest) throw new Error('Processing receipt content digest differs for the same key');
        return existing;
      }
      const candidateIds = output.candidates.map((proposal, index) => {
        const id = digest([key, index]);
        this.saveCandidate({ id, requestKey: key, version: 1, state: 'candidate', digest: digest(proposal),
          evidenceDigest: source.request.evidenceDigest, proposal });
        return id;
      });
      const receipt = { requestKey: key, outputDigest, candidateIds, warnings: output.warnings };
      this.put('processing', key, receipt);
      return receipt;
    });
  }

  getCandidate(id: string): LearningCandidate | undefined { return this.read('candidate', learningDigestSchema.parse(id)); }
  listCandidates(): LearningCandidate[] { return this.all('candidate'); }
  getCandidateVersions(id: string): LearningCandidate[] {
    learningDigestSchema.parse(id);
    return this.all<LearningCandidate>('candidate-version').filter(entry => entry.id === id).sort((first, second) => first.version - second.version);
  }

  transitionCandidate(id: string, expectedVersion: number, state: CandidateState): LearningCandidate {
    versionSchema.parse(expectedVersion);
    candidateStateSchema.parse(state);
    return this.write(() => {
      const current = this.requireCandidate(id, expectedVersion);
      if (state === 'validated') throw new Error('Validated state requires an explicit validation receipt');
      if (state === 'published') throw new Error('Published state requires the explicit publication journal');
      return this.move(current, state);
    });
  }

  recordValidation(id: string, expectedVersion: number, input: CandidateValidation): LearningCandidate {
    versionSchema.parse(expectedVersion);
    const parsed = validationSchema.parse(input);
    return this.write(() => {
      const current = this.requireCandidate(id, expectedVersion);
      if (current.digest !== parsed.candidateDigest || current.evidenceDigest !== parsed.evidenceDigest) throw new Error('Validation candidate or evidence digest differs');
      if (current.state !== 'candidate') throw new Error('Validation requires candidate state');
      const next = parsed.passed ? this.move(current, 'validated') : current;
      const receipt: ValidationReceipt = { ...parsed, candidateId: id, candidateVersion: current.version, validatedVersion: next.version };
      this.insertImmutable('validation', digest([id, current.version, parsed.validatorVersion]), receipt);
      return next;
    });
  }

  getValidation(id: string): ValidationReceipt | undefined {
    learningDigestSchema.parse(id);
    return this.all<ValidationReceipt>('validation').filter(entry => entry.candidateId === id)
      .sort((first, second) => second.validatedVersion - first.validatedVersion)[0];
  }

  preparePublication(id: string, expectedVersion: number, input: PublicationInput): PublicationRecord {
    versionSchema.parse(expectedVersion);
    const parsed = publicationSchema.parse(input);
    return this.write(() => {
      const current = this.requireCandidate(id, expectedVersion);
      const receipt = this.getValidation(id);
      if (current.state !== 'validated' || !receipt?.passed || receipt.validatedVersion !== current.version
        || receipt.candidateDigest !== current.digest || receipt.evidenceDigest !== current.evidenceDigest
        || receipt.validatorVersion !== parsed.validatorVersion) throw new Error('Publication requires a matching validation receipt');
      this.assertPublicationTarget(current, parsed);
      const record: PublicationRecord = { ...parsed, candidateId: id, candidateVersion: current.version,
        candidateDigest: current.digest, evidenceDigest: current.evidenceDigest, phase: 'prepared' };
      const existing = this.read<PublicationRecord>('publication', parsed.key);
      if (existing) {
        const { phase: _phase, observedDigest: _observed, blockedReason: _reason, ...identity } = existing;
        if (canonicalLearningJson(identity) !== canonicalLearningJson({ ...record, phase: undefined })) throw new Error('Publication same key has different content');
        return existing;
      }
      if (this.listUnfinishedPublications().some(entry => entry.candidateId === id)) throw new Error('Candidate has an unfinished publication');
      this.put('publication', parsed.key, record);
      return record;
    });
  }

  advancePublication(key: string, phase: 'applied' | 'committed', observedDigest: string | null): PublicationRecord {
    learningIdentitySchema.parse(key);
    z.enum(['applied', 'committed']).parse(phase);
    learningDigestSchema.nullable().parse(observedDigest);
    return this.write(() => {
      const publication = this.read<PublicationRecord>('publication', key);
      if (!publication) throw new Error('Publication not found');
      if (publication.phase === phase && publication.observedDigest === observedDigest) return publication;
      if (!((publication.phase === 'prepared' && phase === 'applied') || (publication.phase === 'applied' && phase === 'committed'))) throw new Error('Invalid publication phase');
      const current = this.requireCandidate(publication.candidateId);
      this.assertPublicationTarget(current, publication);
      let next: PublicationRecord;
      if (observedDigest !== publication.targetDigest || current.version !== publication.candidateVersion
        || current.digest !== publication.candidateDigest || current.evidenceDigest !== publication.evidenceDigest) {
        next = { ...publication, phase: 'conflict', observedDigest, blockedReason: 'Target digest or candidate version changed; manual recovery required' };
        if (['candidate', 'validated', 'published'].includes(current.state)) this.move(current, 'conflict');
      } else {
        next = { ...publication, phase, observedDigest };
        if (phase === 'committed') this.move(current, 'published');
      }
      this.put('publication', key, next);
      return next;
    });
  }

  getPublication(key: string): PublicationRecord | undefined { return this.read('publication', learningIdentitySchema.parse(key)); }
  listUnfinishedPublications(): PublicationRecord[] {
    return this.all<PublicationRecord>('publication').filter(entry => entry.phase === 'prepared' || entry.phase === 'applied');
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  private requireRequest(key: string): StoredDistillationRequest {
    const entry = this.getRequest(key);
    if (!entry) throw new Error('Learning request not found');
    return entry;
  }

  private assertPublicationTarget(candidate: LearningCandidate, publication: PublicationInput): void {
    const proposal = candidate.proposal;
    if (proposal.targetRef && proposal.targetRef !== publication.targetRef) throw new Error('Publication target differs from candidate target');
    if (proposal.kind !== 'skill') return;
    if (proposal.payload.targetSkill && proposal.payload.targetSkill !== publication.targetRef) throw new Error('Publication target differs from validated skill target');
    if (publication.originalDigest !== (proposal.payload.targetSkill ? proposal.payload.originalDigest : null)) {
      throw new Error('Publication original digest differs from validated skill version');
    }
  }

  private requireCandidate(id: string, expectedVersion?: number): LearningCandidate {
    const candidate = this.getCandidate(id);
    if (!candidate) throw new Error('Learning candidate not found');
    if (expectedVersion !== undefined && candidate.version !== versionSchema.parse(expectedVersion)) throw new Error('Candidate version conflict');
    return candidate;
  }

  private reserveModelCallInTransaction(input: ModelCallInput): ModelCallReservation {
    if (input.limit === 0) throw new Error('Learning model daily budget is disabled (limit=0)');
    const key = digest([input.day, input.callId]);
    const existing = this.read<ModelCallReservation>('model-call', key);
    if (existing) return existing;
    const count = this.getModelCallCount(input.day);
    if (count >= input.limit) throw new Error(`Learning model daily budget reached (${count}/${input.limit}, UTC ${input.day})`);
    const reservation = { day: input.day, callId: input.callId, ordinal: count + 1 };
    this.put('model-call', key, reservation);
    return reservation;
  }

  private requireAnalysisAttempt(callId: string): AnalysisAttempt {
    const attempt = this.read<AnalysisAttempt>('analysis-attempt', callId);
    if (!attempt) throw new Error('Learning analysis attempt not found');
    return attempt;
  }

  private insertRequest(entry: PreparedDistillationRequest): void { this.insertImmutable('request', entry.key, entry); }

  private saveCandidate(candidate: LearningCandidate): LearningCandidate {
    this.insertImmutable('candidate-version', `${candidate.id}:${candidate.version}`, candidate);
    this.put('candidate', candidate.id, candidate);
    return candidate;
  }

  private move(current: LearningCandidate, state: CandidateState): LearningCandidate {
    assertCandidateTransition(current.state, state);
    if (current.state === state) return current;
    return this.saveCandidate({ ...current, state, version: versionSchema.parse(current.version + 1) });
  }

  private insertImmutable<Value>(kind: string, key: string, value: Value): Value {
    const existing = this.read<Value>(kind, key);
    if (existing !== undefined) {
      if (canonicalLearningJson(existing) !== canonicalLearningJson(value)) throw new Error(`Learning ${kind}: same key has different content`);
      return existing;
    }
    this.put(kind, key, value);
    return value;
  }

  private put(kind: string, key: string, value: unknown): void {
    const payload = canonicalLearningJson(value);
    const bytes = Buffer.byteLength(payload) + Buffer.byteLength(key) + Buffer.byteLength(kind) + 64;
    this.database.prepare(`INSERT INTO learning_ledger(kind, key, payload, bytes) VALUES (?, ?, ?, ?)
      ON CONFLICT(kind, key) DO UPDATE SET payload=excluded.payload, bytes=excluded.bytes`).run(kind, key, payload, bytes);
  }

  private read<Value>(kind: string, key: string): Value | undefined {
    this.assertOpen();
    const row = this.database.prepare('SELECT payload FROM learning_ledger WHERE kind = ? AND key = ?').get(kind, key);
    return row ? JSON.parse(String(row.payload)) as Value : undefined;
  }

  private all<Value>(kind: string): Value[] {
    this.assertOpen();
    return this.database.prepare('SELECT payload FROM learning_ledger WHERE kind = ? ORDER BY key').all(kind)
      .map(row => JSON.parse(String(row.payload)) as Value);
  }

  private assertOpen(): void { if (this.closed) throw new Error('Learning candidate store is closed'); }

  private secureFiles(): void {
    if (realpathSync(dirname(this.file)) !== dirname(this.file)) throw new Error('Learning ledger refuses symbolic link parents');
    const parent = lstatSync(dirname(this.file));
    if ((process.getuid && parent.uid !== process.getuid()) || (process.platform !== 'win32' && (parent.mode & 0o077))) {
      throw new Error('Learning ledger parent directory must remain private (0700)');
    }
    for (const path of [this.file, `${this.file}-wal`, `${this.file}-shm`, `${this.file}-journal`]) privateFile(path);
    const current = lstatSync(this.file);
    if (current.dev !== this.fileIdentity.dev || current.ino !== this.fileIdentity.ino) throw new Error('Learning ledger database file changed after open');
  }

  private write<Result>(operation: () => Result): Result {
    this.assertOpen();
    this.secureFiles();
    return transaction(this.database, () => {
      const result = operation();
      const pending = this.database.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM learning_ledger AS request
        WHERE request.kind = 'request' AND NOT EXISTS
        (SELECT 1 FROM learning_ledger AS receipt WHERE receipt.kind = 'processing' AND receipt.key = request.key)`).get()!;
      const total = this.database.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM learning_ledger').get()!;
      if (Number(pending.count) > this.limits.pendingRequests || Number(pending.bytes) > this.limits.pendingBytes
        || Number(total.count) > this.limits.records || Number(total.bytes) > this.limits.recordBytes) {
        throw new Error(`Learning ledger capacity reached (pending ${pending.count}/${this.limits.pendingRequests}, pending bytes ${pending.bytes}/${this.limits.pendingBytes}, records ${total.count}/${this.limits.records}, record bytes ${total.bytes}/${this.limits.recordBytes}); transaction rolled back; explicit retention or capacity recovery required`);
      }
      this.secureFiles();
      return result;
    });
  }
}
