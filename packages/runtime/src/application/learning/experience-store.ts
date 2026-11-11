import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseCanonicalProject, parseWorkItemId } from '../../domain/work-item/identity.js';
import { redactUtf8 } from '../../infrastructure/observability/local-evidence-store.js';
import { openSqlite, transaction, type SqliteDatabase } from '../../infrastructure/storage/sqlite.js';
import type { ContextQuery } from '../../plugin-sdk/capabilities.js';

const MAX_RECORDS = 1000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_BYTES = 32 * 1024;
const MAX_RECEIPTS = 256;
const DAY = 24 * 60 * 60 * 1000;
const MAX_EXCHANGE_BYTES = 1024 * 1024;
const MAX_ADOPTIONS = 64;
const recallSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });

function recallTerms(value: string): Set<string> {
  const normalized = value.toLowerCase();
  const identifier = /[\p{Script=Latin}\p{N}_]+(?:[./:-][\p{Script=Latin}\p{N}_]+)*/gu;
  const identifiers = normalized.match(identifier) ?? [];
  const words = [...recallSegmenter.segment(normalized.replace(identifier, ' '))]
    .filter(part => part.isWordLike).map(part => part.segment);
  return new Set([...identifiers, ...words].filter(term => term.length >= 2
    && !['the', 'and', 'for', 'with', 'this', 'that', 'please', 'fix', 'is', 'are', 'was', 'were', 'not', 'no', 'only'].includes(term)));
}

const recallExclusion = /\b(?:exclude|excluding|except|avoid|ignore|do\s+not|don't)\b|不要|不采用|不使用|排除/iu;
const recallProjectMention = /\b(?:github|gitlab):[\w.-]+(?:\/[\w.-]+)+(?:#[1-9]\d*)?/giu;
const recallNegativeCue = /\bis\s+absent\b|\bno\s+|没有/iu;
const recallRequiresContext = /\b(?:validated|verified|tested)\s+only\s+(?:on|for)\b|仅在[^;；。\n]+?(?:验证|测试)/iu;
const recallClauseBoundary = /[;；。！？!?\n,，]|\.(?=\s|$)|\s+(?:but|however|instead)\s+|但是|而是/iu;

function recallDenialDescription(value: string): string | undefined {
  return /\bno\s+(.+)$/u.exec(value)?.[1] ?? /^(.+?)\s+is\s+absent\b/u.exec(value)?.[1];
}

function recallProjectMatches(scope: string, clauses: string[]): boolean {
  for (const clause of clauses) {
    const mentions = [...clause.matchAll(recallProjectMention)];
    for (const [index, mention] of mentions.entries()) {
      const previous = mentions[index - 1];
      const prefix = clause.slice(previous ? previous.index! + previous[0].length : 0, mention.index);
      const suffix = clause.slice(mention.index! + mention[0].length, mentions[index + 1]?.index);
      const exclusion = recallExclusion.exec(prefix);
      const excluded = Boolean(exclusion && recallTerms(prefix.slice(exclusion.index + exclusion[0].length)).size <= 1)
        || /^\s*(?:(?:must|should)\s+remain\s+unchanged\b|保持不变)/iu.test(suffix);
      const project = mention[0].replace(/^(?:github|gitlab):/iu, prefix => prefix.toLowerCase()).replace(/#[1-9]\d*$/, '');
      try { parseCanonicalProject(project); } catch { return false; }
      if (excluded ? project === scope : project !== scope) return false;
    }
  }
  return true;
}

function recallDenied(record: ExperienceRecord, clauses: string[]): boolean {
  const trigger = record.trigger.toLowerCase();
  const identifiers = record.trigger.match(/\b[A-Z][A-Z\d_]*(?:-\d+)?\b/gu) ?? [];
  for (const clause of clauses) {
    const normalized = clause.toLowerCase();
    if (trigger.includes(normalized)) continue;
    const deniedDescription = recallDenialDescription(normalized);
    if (deniedDescription) {
      const deniedTerms = [...recallTerms(deniedDescription)];
      const failureTerms = recallTerms(`${record.trigger} ${record.rootCause}`);
      if (deniedTerms.length >= 2 && deniedTerms.some(term => /^(?:errors?|failures?|faults?|issues?|failed)$/u.test(term))
        && deniedTerms.every(term => failureTerms.has(term))) {
        const describedAbsence = [record.trigger, record.rootCause].flatMap(value => value.toLowerCase().split(recallClauseBoundary)).some(part => {
          const description = recallDenialDescription(part);
          const descriptionTerms = description === undefined ? undefined : recallTerms(description);
          return descriptionTerms?.size === deniedTerms.length && deniedTerms.every(term => descriptionTerms.has(term));
        });
        if (!describedAbsence) return true;
      }
    }
    for (const identifier of identifiers) {
      const anchor = identifier.toLowerCase();
      if (!recallTerms(clause).has(anchor)) continue;
      if (normalized.includes(`no ${anchor}`) || normalized.includes(`没有发生${anchor}`)
        || ['is absent', 'is not present', 'is not applicable', 'is not the issue', 'did not occur', 'did not recur']
          .some(denial => normalized.includes(`${anchor} ${denial}`))) return true;
    }
    for (const denied of normalized.matchAll(/没有(?:发生)?([^，,；;。且]+)/gu)) {
      if (trigger.includes(denied[1].trim())) return true;
    }
    const exclusion = recallExclusion.exec(clause);
    if (exclusion) {
      const excluded = [...recallTerms(clause.slice(exclusion.index + exclusion[0].length))];
      if (excluded.some(term => /[_:/-]/u.test(term) && recallTerms(trigger).has(term))) return true;
      const action = record.action.toLowerCase();
      if (excluded.length >= 2 && excluded.every(term => action.includes(term))) return true;
    }
  }
  return false;
}

function text(maxBytes: number) {
  return z.string().max(maxBytes).trim().min(1).refine(value => Buffer.byteLength(value) <= maxBytes, 'Text exceeds byte limit')
    .refine(value => !value.includes('\0'), 'NUL is not allowed');
}

function redact(value: string): string {
  return Buffer.from(redactUtf8(Buffer.from(value)).bytes).toString('utf8')
    .replace(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g, '[redacted:private-key]')
    .replace(/("(?:[\w-]*(?:token|secret|password)|api[_-]?key)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[redacted]"')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, '$1 [redacted]')
    .replace(/([?&](?:[\w-]*(?:token|secret|password|signature|credential)|key|auth|authorization)=)[^&#\s]*/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@');
}

const identity = text(512).refine(value => redact(value) === value, 'Identity must not contain credentials');
const versionMapSchema = z.record(identity, identity).refine(value => Object.keys(value).length <= 32);
function ownProperties(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, ownProperties(entry)]));
}

export const experienceQueryContextSchema = z.preprocess(ownProperties, z.object({
  applicability: z.object({ version: identity.optional(), environment: identity.optional() }).strict().optional(),
  target: z.object({ project: identity, revision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional(),
    dirty: z.boolean().optional(), productVersions: versionMapSchema.optional(), runtimeVersions: versionMapSchema.optional(),
    conditions: z.record(identity, z.boolean()).refine(value => Object.keys(value).length <= 32).optional(),
  }).strict().optional(),
}).strict());
export type ExperienceQueryContext = Pick<ContextQuery, 'applicability' | 'target'>;

export function experienceContextMatches(required: ExperienceQueryContext, actual: ExperienceQueryContext): boolean {
  function matches(expected: unknown, observed: unknown): boolean {
    if (!expected || typeof expected !== 'object') return expected === observed;
    if (!observed || typeof observed !== 'object') return false;
    return Object.entries(expected).every(([key, value]) => value === undefined
      || (Object.hasOwn(observed, key) && matches(value, Reflect.get(observed, key))));
  }
  return matches(required, actual);
}
const sourceSchema = z.object({ runId: identity, workItemId: identity }).strict();
const evidenceSchema = z.array(text(256).refine(value => !/[\r\n]/.test(value), 'Evidence must be a reference').transform(redact)).min(1).max(8)
  .transform(values => [...new Set(values)]);
const statusSchema = z.enum(['candidate', 'verified', 'revoked']);
const failureSchema = z.object({
  scope: identity,
  trigger: text(1024).transform(redact),
  rootCause: text(2048).transform(redact),
  action: text(4096).transform(redact),
  evidence: evidenceSchema,
  source: sourceSchema,
  expiresAt: z.string().datetime().optional(),
}).strict();
const verificationSchema = z.object({ evidence: evidenceSchema, runId: identity,
  action: text(4096).transform(redact).optional(), rootCause: text(2048).transform(redact).optional() }).strict();
const observationSchema = z.object({ source: sourceSchema, evidence: evidenceSchema, recordedAt: z.string().datetime() }).strict();
const failureIdentitySchema = failureSchema.pick({ trigger: true, rootCause: true, action: true });
const originSchema = z.object({ scope: identity, id: z.string().uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), source: sourceSchema }).strict();
const kindSchema = z.enum(['failure', 'success']);
const receiptSchema = z.object({ sourceHash: z.string().regex(/^[a-f0-9]{64}$/), runHash: z.string().regex(/^[a-f0-9]{64}$/),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const portableSchema = z.object({
  version: z.literal(1), scope: identity,
  experiences: z.array(z.object({
    kind: kindSchema, trigger: failureSchema.shape.trigger, rootCause: failureSchema.shape.rootCause,
    action: failureSchema.shape.action, evidence: evidenceSchema, expiresAt: z.string().datetime(), origin: originSchema,
    failureIdentity: failureIdentitySchema.optional(),
    receipts: z.array(receiptSchema).min(1).max(MAX_RECEIPTS),
  }).strict().superRefine((entry, context) => {
    if ((entry.kind === 'failure') !== (entry.failureIdentity !== undefined)) context.addIssue({ code: z.ZodIssueCode.custom,
      message: 'Failure exchange requires the original failure identity; success exchange must omit it' });
  })).max(100),
}).strict();
const metricCountsSchema = z.object({ retrievals: z.number().int().nonnegative().safe(), adoptions: z.number().int().nonnegative().max(MAX_ADOPTIONS),
  recurrences: z.number().int().nonnegative().safe() }).strict();
const recordSchema = failureSchema.omit({ expiresAt: true }).extend({
  id: z.string().uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  failureFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  failureIdentity: failureIdentitySchema.optional(),
  status: statusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  occurrences: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  observations: z.array(observationSchema).min(1).max(8),
  verifiedEvidence: verificationSchema.extend({ verifiedAt: z.string().datetime() }).optional(),
  provenanceSaturated: z.boolean().optional(),
  kind: kindSchema.optional(),
  origin: originSchema.optional(),
}).strict();

export type ExperienceStatus = z.infer<typeof statusSchema>;
export type RecordFailureInput = z.input<typeof failureSchema>;
export type ExperienceVerification = z.input<typeof verificationSchema>;
export type ExperienceRecord = z.infer<typeof recordSchema>;
export type ExperienceExchange = z.infer<typeof portableSchema>;
export type ExperienceMetrics = z.infer<typeof metricCountsSchema>;
export interface ExperienceStoreOptions { file: string; now?: () => Date }

const verificationHistorySchema = `
CREATE TABLE experience_verifications (
  experience_id TEXT NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
  run_hash TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  PRIMARY KEY(experience_id, run_hash)
) STRICT, WITHOUT ROWID;
`;
const applicabilityTableSchema = `
CREATE TABLE experience_applicability (
  experience_id TEXT PRIMARY KEY REFERENCES experiences(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  run_hash TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(length(payload) <= 16384)
) STRICT, WITHOUT ROWID;
`;

const schema = `
CREATE TABLE experiences (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('candidate', 'verified', 'revoked')),
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes > 0 AND bytes <= ${MAX_RECORD_BYTES}),
  payload TEXT NOT NULL
) STRICT;
CREATE INDEX experiences_scope ON experiences(scope, status, expires_at);
CREATE TABLE experience_receipts (
  experience_id TEXT NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  run_hash TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  PRIMARY KEY(experience_id, source_hash)
) STRICT, WITHOUT ROWID;
${verificationHistorySchema}
${applicabilityTableSchema}
`;

export class ExperienceStore {
  private readonly database: SqliteDatabase;
  private readonly now: () => Date;
  private closed = false;

  constructor(options: ExperienceStoreOptions) {
    const parsed = z.object({ file: text(4096), now: z.function().optional() }).strict().parse(options);
    this.now = options.now ?? (() => new Date());
    this.timestamp();
    this.database = openSqlite({ file: parsed.file, schema, durability: 'FULL', version: 3,
      migrations: [{ from: 1, to: 2, migrate: database => {
        database.exec(verificationHistorySchema);
        for (const row of database.prepare('SELECT payload FROM experiences').all()) {
          const record = this.read(row)!;
          if (record.verifiedEvidence) database.prepare('INSERT INTO experience_verifications VALUES (?, ?, ?)')
            .run(record.id, this.hash(record.verifiedEvidence.runId), this.hash([...record.verifiedEvidence.evidence].sort()));
        }
      } }, { from: 2, to: 3, migrate: database => database.exec(applicabilityTableSchema) }],
    });
    try {
      const pageSize = Number(this.database.prepare('PRAGMA page_size').get()?.page_size);
      this.database.exec(`PRAGMA max_page_count = ${Math.floor(32 * 1024 * 1024 / pageSize)}; PRAGMA journal_size_limit = 1048576; PRAGMA wal_autocheckpoint = 128;`);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  recordFailure(input: RecordFailureInput): ExperienceRecord {
    this.assertOpen();
    const parsed = failureSchema.parse(input);
    const now = this.timestamp();
    const expiry = new Date(parsed.expiresAt ?? Date.parse(now) + 90 * DAY).toISOString();
    const fingerprint = this.fingerprint(parsed);
    return transaction(this.database, () => {
      const existing = this.read(this.database.prepare("SELECT payload FROM experiences WHERE fingerprint = ? OR json_extract(payload, '$.failureFingerprint') = ?").get(fingerprint, fingerprint));
      const receipt = { sourceHash: this.hash(parsed.source), runHash: this.hash(parsed.source.runId), evidenceHash: this.hash([...parsed.evidence].sort()) };
      const seen = existing && this.database.prepare('SELECT evidence_hash FROM experience_receipts WHERE experience_id = ? AND source_hash = ?')
        .get(existing.id, receipt.sourceHash);
      if (seen?.evidence_hash === receipt.evidenceHash) return existing!;
      const previous = existing?.observations.find(entry => entry.source.runId === parsed.source.runId && entry.source.workItemId === parsed.source.workItemId);
      if (existing?.provenanceSaturated && previous && parsed.evidence.every(ref => previous.evidence.includes(ref))) return existing;
      if (Date.parse(expiry) <= Date.parse(now) || Date.parse(expiry) > Date.parse(now) + 365 * DAY) {
        throw new Error('Experience expiry must be in the next 365 days');
      }
      const observation = { source: parsed.source, evidence: parsed.evidence, recordedAt: now };
      if (!existing) {
        return this.save({ ...parsed, id: randomUUID(), fingerprint, failureFingerprint: fingerprint,
          failureIdentity: { trigger: parsed.trigger, rootCause: parsed.rootCause, action: parsed.action }, status: 'candidate', createdAt: now, updatedAt: now,
          expiresAt: expiry, occurrences: 1, observations: [observation] }, receipt);
      }
      const observations = existing.observations.filter(entry => entry !== previous);
      observations.push(previous ? { ...observation, evidence: [...new Set([...previous.evidence, ...parsed.evidence])].slice(-8) } : observation);
      const expired = Date.parse(existing.expiresAt) <= Date.parse(now);
      const knownRun = this.database.prepare('SELECT 1 FROM experience_receipts WHERE experience_id = ? AND run_hash = ?').get(existing.id, receipt.runHash);
      const knownEvidence = this.database.prepare('SELECT 1 FROM experience_receipts WHERE experience_id = ? AND evidence_hash = ?').get(existing.id, receipt.evidenceHash);
      const recurrence = !knownRun && !knownEvidence && parsed.evidence.some(ref =>
        !existing.evidence.includes(ref) && !existing.observations.some(entry => entry.evidence.includes(ref)));
      const keepVerified = existing.status === 'verified' && !expired && !recurrence;
      if (recurrence && !existing.provenanceSaturated) this.incrementMetric(existing.id, 'recurrences');
      return this.save({ ...existing, status: existing.status === 'revoked' ? 'revoked' : keepVerified ? 'verified' : 'candidate',
        verifiedEvidence: existing.status === 'revoked' || keepVerified ? existing.verifiedEvidence : undefined,
        evidence: [...new Set([...existing.evidence, ...parsed.evidence])].slice(-8), observations: observations.slice(-8),
        occurrences: existing.occurrences + (seen || previous ? 0 : 1), updatedAt: now,
        expiresAt: expired ? expiry : existing.expiresAt }, receipt);
    });
  }

  recordSuccess(input: RecordFailureInput): ExperienceRecord {
    this.assertOpen();
    const parsed = failureSchema.parse(input);
    parseCanonicalProject(parsed.scope);
    const workItem = parseWorkItemId(parsed.source.workItemId);
    if (`${workItem.platform}:${workItem.projectKey}` !== parsed.scope) throw new Error('Success work item does not belong to scope');
    const now = this.timestamp();
    const expiresAt = parsed.expiresAt ?? new Date(Date.parse(now) + 90 * DAY).toISOString();
    if (Date.parse(expiresAt) <= Date.parse(now) || Date.parse(expiresAt) > Date.parse(now) + 365 * DAY) throw new Error('Experience expiry must be in the next 365 days');
    const fingerprint = this.fingerprint({ ...parsed, kind: 'success' });
    return transaction(this.database, () => {
      const existing = this.read(this.database.prepare('SELECT payload FROM experiences WHERE fingerprint = ?').get(fingerprint));
      const receipt = { sourceHash: this.hash(parsed.source), runHash: this.hash(parsed.source.runId), evidenceHash: this.hash([...parsed.evidence].sort()) };
      if (existing && (existing.status === 'revoked' || existing.provenanceSaturated ||
        this.database.prepare('SELECT 1 FROM experience_receipts WHERE experience_id = ? AND source_hash = ?').get(existing.id, receipt.sourceHash))) return existing;
      const record = this.save({ ...parsed, source: existing?.source ?? parsed.source, kind: 'success', id: existing?.id ?? randomUUID(), fingerprint, status: 'verified', createdAt: existing?.createdAt ?? now, updatedAt: now,
        expiresAt, occurrences: (existing?.occurrences ?? 0) + 1,
        observations: [...(existing?.observations ?? []), { source: parsed.source, evidence: parsed.evidence, recordedAt: now }].slice(-8),
        verifiedEvidence: { runId: parsed.source.runId, evidence: parsed.evidence, verifiedAt: now } },
      receipt);
      if (!record.provenanceSaturated) this.database.prepare('INSERT INTO experience_verifications VALUES (?, ?, ?)')
        .run(record.id, receipt.runHash, receipt.evidenceHash);
      return record;
    });
  }

  export(input: { scope: string; limit?: number }): string {
    this.assertOpen();
    const parsed = z.object({ scope: identity, limit: z.number().int().min(0).max(100).default(100) }).strict().parse(input);
    parseCanonicalProject(parsed.scope);
    const records = this.database.prepare("SELECT payload FROM experiences WHERE scope = ? AND status <> 'revoked' AND expires_at > ? AND json_extract(payload, '$.provenanceSaturated') IS NOT 1 AND NOT EXISTS (SELECT 1 FROM experience_applicability WHERE experience_id = experiences.id) ORDER BY updated_at DESC, id LIMIT ?")
      .all(parsed.scope, this.timestamp(), parsed.limit).map(row => this.read(row)!);
    const document: ExperienceExchange = { version: 1, scope: parsed.scope, experiences: records.map(record => this.portable(record)) };
    const json = JSON.stringify(document);
    if (Buffer.byteLength(json) + 1 > MAX_EXCHANGE_BYTES) throw new Error('Experience exchange exceeds byte limit (1048576)');
    return json;
  }

  import(input: { scope: string; json: string }): ExperienceRecord[] {
    this.assertOpen();
    const parsed = z.object({ scope: identity, json: z.string().max(MAX_EXCHANGE_BYTES) }).strict().parse(input);
    parseCanonicalProject(parsed.scope);
    if (Buffer.byteLength(parsed.json) > MAX_EXCHANGE_BYTES) throw new Error('Experience exchange exceeds byte limit (1048576)');
    const document = portableSchema.parse(JSON.parse(parsed.json));
    parseCanonicalProject(document.scope);
    for (const entry of document.experiences) {
      parseCanonicalProject(entry.origin.scope);
      const workItem = parseWorkItemId(entry.origin.source.workItemId);
      if (`${workItem.platform}:${workItem.projectKey}` !== entry.origin.scope) throw new Error('Experience origin work item does not belong to source scope');
      if (new Set(entry.receipts.map(receipt => receipt.sourceHash)).size !== entry.receipts.length
        || !entry.receipts.some(receipt => receipt.sourceHash === this.hash(entry.origin.source) && receipt.runHash === this.hash(entry.origin.source.runId))) {
        throw new Error('Experience source receipts must include its origin without duplicates');
      }
      const expiry = Date.parse(entry.expiresAt);
      const now = Date.parse(this.timestamp());
      if (expiry <= now || expiry > now + 365 * DAY) throw new Error('Experience expiry must be in the next 365 days');
    }
    return transaction(this.database, () => document.experiences.map(entry => {
      const now = this.timestamp();
      const fingerprint = this.hash(['exchange', parsed.scope, entry.origin.scope, entry.origin.id, entry.origin.fingerprint]);
      const existing = this.read(this.database.prepare('SELECT payload FROM experiences WHERE fingerprint = ?').get(fingerprint));
      const contentFingerprint = this.fingerprint({ ...entry, scope: parsed.scope });
      const failureFingerprint = entry.failureIdentity ? this.fingerprint({ ...entry.failureIdentity, scope: parsed.scope }) : contentFingerprint;
      const originFingerprint = entry.origin.scope === parsed.scope ? entry.origin.fingerprint : '';
      const governed = this.database.prepare(`SELECT id FROM experiences WHERE scope = ? AND id <> ? AND (
        id = ? OR fingerprint IN (?, ?, ?) OR json_extract(payload, '$.failureFingerprint') IN (?, ?, ?)
        OR (json_extract(payload, '$.origin.scope') = ? AND json_extract(payload, '$.origin.id') = ?))`)
        .get(parsed.scope, existing?.id ?? '', entry.origin.scope === parsed.scope ? entry.origin.id : '',
          contentFingerprint, failureFingerprint, originFingerprint, contentFingerprint, failureFingerprint, originFingerprint, entry.origin.scope, entry.origin.id);
      if (governed) throw new Error('Experience already exists under local governance; import cannot replace its identity or history');
      if (existing) {
        if (existing.status !== 'candidate') throw new Error('Experience already locally verified or revoked; import cannot replace local governance');
        if (existing.trigger !== entry.trigger || existing.rootCause !== entry.rootCause || existing.action !== entry.action || existing.kind !== entry.kind
          || JSON.stringify(existing.origin?.source) !== JSON.stringify(entry.origin.source)
          || JSON.stringify(this.originalFailure(existing)) !== JSON.stringify(entry.failureIdentity)) {
          throw new Error('Experience origin conflicts with previously imported content');
        }
        this.importReceipts(existing.id, entry.receipts);
        return existing;
      }
      const { receipts, ...content } = entry;
      const record = this.save({ ...content, scope: parsed.scope, source: entry.origin.source, id: randomUUID(), fingerprint,
        failureFingerprint: entry.kind === 'failure' ? failureFingerprint : undefined,
        status: 'candidate', createdAt: now, updatedAt: now, occurrences: 1,
        observations: [{ source: entry.origin.source, evidence: entry.evidence, recordedAt: now }] });
      this.importReceipts(record.id, receipts);
      return record;
    }));
  }

  copy(input: { id: string; scope: string; targetScope: string }): ExperienceRecord {
    this.assertOpen();
    const parsed = z.object({ id: z.string().uuid(), scope: identity, targetScope: identity }).strict().parse(input);
    parseCanonicalProject(parsed.scope);
    parseCanonicalProject(parsed.targetScope);
    if (parsed.scope === parsed.targetScope) throw new Error('Copy requires a different target project');
    const record = this.get(parsed.id, parsed.scope);
    if (!record || record.status !== 'verified' || Date.parse(record.expiresAt) <= Date.parse(this.timestamp())) throw new Error('Copy requires a live verified source experience');
    return this.import({ scope: parsed.targetScope, json: JSON.stringify({ version: 1, scope: parsed.scope, experiences: [this.portable(record)] }) })[0];
  }

  metrics(input: { scope: string }): ExperienceMetrics {
    this.assertOpen();
    const parsed = z.object({ scope: identity }).strict().parse(input);
    parseCanonicalProject(parsed.scope);
    const counts = { retrievals: 0, adoptions: 0, recurrences: 0 };
    for (const row of this.database.prepare(`SELECT r.evidence_hash FROM experience_receipts r JOIN experiences e ON e.id = r.experience_id
      WHERE e.scope = ? AND r.source_hash = 'metric:counts'`).all(parsed.scope)) {
      const metrics = metricCountsSchema.parse(JSON.parse(String(row.evidence_hash)));
      for (const key of ['retrievals', 'adoptions', 'recurrences'] as const) counts[key] = Math.min(Number.MAX_SAFE_INTEGER, counts[key] + metrics[key]);
    }
    return counts;
  }

  adopt(input: { id: string; scope: string; source: RecordFailureInput['source'] }): ExperienceMetrics {
    this.assertOpen();
    const parsed = z.object({ id: z.string().uuid(), scope: identity, source: sourceSchema }).strict().parse(input);
    parseCanonicalProject(parsed.scope);
    const workItem = parseWorkItemId(parsed.source.workItemId);
    if (`${workItem.platform}:${workItem.projectKey}` !== parsed.scope) throw new Error('Adoption work item does not belong to scope');
    return transaction(this.database, () => {
      const record = this.get(parsed.id, parsed.scope);
      if (!record || record.status !== 'verified' || Date.parse(record.expiresAt) <= Date.parse(this.timestamp())) throw new Error('Adoption requires a live verified experience in scope');
      const key = `metric:adoption:${this.hash(parsed.source)}`;
      if (this.database.prepare('SELECT 1 FROM experience_receipts WHERE experience_id = ? AND source_hash = ?').get(record.id, key)) return this.metrics({ scope: parsed.scope });
      const count = this.database.prepare("SELECT COUNT(*) AS count FROM experience_receipts WHERE experience_id = ? AND source_hash LIKE 'metric:adoption:%'").get(record.id)!;
      if (Number(count.count) >= MAX_ADOPTIONS) throw new Error(`Experience adoption limit reached (${MAX_ADOPTIONS})`);
      this.database.prepare('INSERT INTO experience_receipts VALUES (?, ?, ?, ?)').run(record.id, key, 'metric', 'metric');
      this.incrementMetric(record.id, 'adoptions');
      this.enforceBounds([record.id]);
      return this.metrics({ scope: parsed.scope });
    });
  }

  get(id: string, scope: string): ExperienceRecord | undefined {
    this.assertOpen();
    const parsedId = z.string().uuid().parse(id);
    const parsedScope = identity.parse(scope);
    return this.read(this.database.prepare('SELECT payload FROM experiences WHERE id = ? AND scope = ?').get(parsedId, parsedScope));
  }

  list(input: { scope: string; status?: ExperienceStatus; limit?: number }): ExperienceRecord[] {
    this.assertOpen();
    const parsed = z.object({ scope: identity, status: statusSchema.optional(), limit: z.number().int().min(0).max(100).default(20) }).strict().parse(input);
    return this.database.prepare(`SELECT payload FROM experiences WHERE scope = ? ${parsed.status ? 'AND status = ?' : ''} ORDER BY updated_at DESC, id LIMIT ?`)
      .all(...(parsed.status ? [parsed.scope, parsed.status, parsed.limit] : [parsed.scope, parsed.limit]))
      .map(row => this.read(row)!);
  }

  recall(input: { scope: string; prompt: string; limit?: number; maxChars?: number } & ExperienceQueryContext): ExperienceRecord[] {
    this.assertOpen();
    if ((input.target && !Object.hasOwn(input, 'target')) || (input.applicability && !Object.hasOwn(input, 'applicability'))) return [];
    const context = experienceQueryContextSchema.safeParse({ applicability: input.applicability, target: input.target });
    if (!context.success) return [];
    const { applicability: _applicability, target: _target, ...request } = input;
    const parsed = z.object({ scope: identity, prompt: text(8192), limit: z.number().int().min(0).max(100).default(5),
      maxChars: z.number().int().min(0).max(MAX_RECORD_BYTES).default(8000) }).strict().parse(request);
    const query = { ...parsed, ...context.data };
    if (query.target && query.target.project !== parsed.scope) return [];
    const prompt = redact(parsed.prompt);
    const clauses = prompt.split(recallClauseBoundary).map(clause => clause.trim()).filter(Boolean);
    if (!query.target && !recallProjectMatches(parsed.scope, clauses)) return [];
    if (!parsed.limit || parsed.maxChars < 2) return [];
    const records = this.database.prepare('SELECT payload FROM experiences WHERE scope = ? AND status = ? AND expires_at > ?')
      .all(parsed.scope, 'verified', this.timestamp()).map(row => this.read(row)!);
    const positive = clauses.map(clause => clause.slice(0, recallExclusion.exec(clause)?.index)).filter(Boolean);
    const terms = [...recallTerms(positive.join('\n'))];
    if (!terms.length) return [];
    const candidates = records.filter(record => this.applicable(record, query) && !recallDenied(record, clauses))
      .map(record => {
        const words = recallTerms(`${record.trigger} ${record.rootCause} ${record.action}`);
        const trigger = recallTerms(record.trigger);
        const score = terms.filter(term => words.has(term)).length;
        const affirmative = recallTerms(positive.filter(clause => !recallNegativeCue.test(clause)
          || record.trigger.toLowerCase().includes(clause.toLowerCase())).join('\n'));
        const affirmativeScore = [...affirmative].filter(term => words.has(term)).length;
        const matched = affirmativeScore >= Math.min(2, terms.length) || terms.some(term => trigger.has(term))
          && (score >= 2 || [...affirmative].some(term => trigger.has(term)));
        return { record, score: matched ? score : 0 };
      }).filter(candidate => candidate.score > 0)
      .sort((left, right) => right.score - left.score || right.record.updatedAt.localeCompare(left.record.updatedAt) || left.record.id.localeCompare(right.record.id));
    const selected: ExperienceRecord[] = [];
    let remaining = parsed.maxChars - 2;
    for (const { record } of candidates) {
      const size = JSON.stringify(record).length + (selected.length ? 1 : 0);
      if (size > remaining) continue;
      selected.push(record);
      remaining -= size;
      if (selected.length === parsed.limit) break;
    }
    transaction(this.database, () => {
      for (const record of selected) this.incrementMetric(record.id, 'retrievals');
      if (selected.length) this.enforceBounds(selected.map(record => record.id));
    });
    return selected;
  }

  verify(id: string, input: ExperienceVerification, context?: ExperienceQueryContext): ExperienceRecord {
    this.assertOpen();
    const parsed = verificationSchema.parse(input);
    return transaction(this.database, () => {
      const record = this.require(id);
      const previousContext = this.database.prepare('SELECT payload FROM experience_applicability WHERE experience_id = ?').get(record.id);
      if (previousContext && !context) throw new Error('Existing applicability requires fresh explicit verification context');
      const required = context && experienceQueryContextSchema.parse(context);
      if (required && required.target?.project !== record.scope) {
        throw new Error('Experience applicability requires an explicit target in the same project');
      }
      const contextPayload = required && JSON.stringify(required);
      const now = this.timestamp();
      if (record.status === 'revoked') throw new Error('Revoked experience cannot be verified');
      if (Date.parse(record.expiresAt) <= Date.parse(now)) throw new Error('Expired experience cannot be verified');
      if (record.provenanceSaturated) throw new Error('Experience provenance is saturated; independent verification cannot be established');
      if (this.database.prepare('SELECT 1 FROM experience_receipts WHERE experience_id = ? AND run_hash = ?').get(record.id, this.hash(parsed.runId))) {
        throw new Error('Verification requires an independent run');
      }
      if (parsed.evidence.every(ref => record.observations.some(entry => entry.evidence.includes(ref)))
        || this.database.prepare('SELECT 1 FROM experience_receipts WHERE experience_id = ? AND evidence_hash = ?')
          .get(record.id, this.hash([...parsed.evidence].sort()))) {
        throw new Error('Verification requires new evidence');
      }
      const corrected = { ...record, failureFingerprint: record.failureFingerprint ?? record.fingerprint,
        failureIdentity: this.originalFailure(record), action: parsed.action ?? record.action, rootCause: parsed.rootCause ?? record.rootCause };
      const fingerprint = record.origin ? record.fingerprint : this.fingerprint(corrected);
      const conflict = this.database.prepare("SELECT id FROM experiences WHERE (fingerprint = ? OR json_extract(payload, '$.failureFingerprint') = ?) AND id <> ?").get(fingerprint, fingerprint, record.id);
      if (conflict) throw new Error('Corrected experience already exists');
      if (record.status === 'verified' && record.verifiedEvidence?.runId === parsed.runId
        && record.fingerprint === fingerprint && JSON.stringify(record.verifiedEvidence.evidence) === JSON.stringify(parsed.evidence)) {
        if (contextPayload !== previousContext?.payload) throw new Error('Changing applicability requires fresh QA evidence');
        return record;
      }
      const runHash = this.hash(parsed.runId);
      const evidenceHash = this.hash([...parsed.evidence].sort());
      if (this.database.prepare('SELECT 1 FROM experience_verifications WHERE experience_id = ? AND (run_hash = ? OR evidence_hash = ?)')
        .get(record.id, runHash, evidenceHash)) throw new Error('Verification requires a fresh run and evidence');
      const verifications = this.database.prepare('SELECT COUNT(*) AS count FROM experience_verifications WHERE experience_id = ?').get(record.id)!;
      if (Number(verifications.count) >= MAX_RECEIPTS) throw new Error(`Experience verification limit reached (${MAX_RECEIPTS})`);
      this.database.prepare('INSERT INTO experience_verifications VALUES (?, ?, ?)').run(record.id, runHash, evidenceHash);
      const verified = this.save({ ...corrected, fingerprint, status: 'verified', updatedAt: now, verifiedEvidence: { ...parsed, verifiedAt: now } });
      if (contextPayload) {
        this.database.prepare(`INSERT INTO experience_applicability VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(experience_id) DO UPDATE SET fingerprint=excluded.fingerprint, run_hash=excluded.run_hash,
          evidence_hash=excluded.evidence_hash, payload=excluded.payload`).run(record.id, this.fingerprint(verified), runHash, evidenceHash, contextPayload);
        this.enforceBounds([record.id]);
      }
      return verified;
    });
  }

  revoke(id: string): ExperienceRecord {
    this.assertOpen();
    return transaction(this.database, () => {
      const record = this.require(id);
      return record.status === 'revoked' ? record : this.save({ ...record, status: 'revoked', updatedAt: this.timestamp() });
    });
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  private timestamp(): string {
    return z.date().parse(this.now()).toISOString();
  }

  private applicable(record: ExperienceRecord, context: ExperienceQueryContext): boolean {
    const row = this.database.prepare('SELECT * FROM experience_applicability WHERE experience_id = ?').get(record.id);
    const products = Object.keys(context.target?.productVersions ?? {});
    if (!row) return !products.length && !recallRequiresContext.test(record.action);
    if (!record.verifiedEvidence || row.fingerprint !== this.fingerprint(record) || row.run_hash !== this.hash(record.verifiedEvidence.runId)
      || row.evidence_hash !== this.hash([...record.verifiedEvidence.evidence].sort())) return false;
    const required = experienceQueryContextSchema.parse(JSON.parse(String(row.payload)));
    if (products.some(product => !Object.hasOwn(required.target?.productVersions ?? {}, product))) return false;
    return experienceContextMatches(required, context);
  }

  private fingerprint(input: Pick<ExperienceRecord, 'scope' | 'trigger' | 'rootCause' | 'action' | 'kind'>): string {
    const parts = [input.scope, input.trigger, input.rootCause, input.action];
    return this.hash(input.kind === 'success' ? [...parts, 'success'] : parts);
  }

  private portable(record: ExperienceRecord): ExperienceExchange['experiences'][number] {
    if (this.database.prepare('SELECT 1 FROM experience_applicability WHERE experience_id = ?').get(record.id)) {
      throw new Error('Version 1 exchange cannot represent structured applicability');
    }
    const failureIdentity = this.originalFailure(record);
    if (record.kind !== 'success' && !failureIdentity) throw new Error('Original failure identity is unavailable; exchange cannot safely preserve recurrence');
    const receipts = this.database.prepare("SELECT source_hash, run_hash, evidence_hash FROM experience_receipts WHERE experience_id = ? AND source_hash NOT LIKE 'metric:%' ORDER BY source_hash")
      .all(record.id).map(row => ({ sourceHash: String(row.source_hash), runHash: String(row.run_hash), evidenceHash: String(row.evidence_hash) }));
    return { kind: record.kind ?? 'failure', failureIdentity, trigger: record.trigger, rootCause: record.rootCause, action: record.action, evidence: record.evidence,
      expiresAt: record.expiresAt, receipts, origin: record.origin ?? { scope: record.scope, id: record.id, fingerprint: record.fingerprint, source: record.source } };
  }

  private originalFailure(record: ExperienceRecord): ExperienceRecord['failureIdentity'] {
    if (record.kind === 'success') return undefined;
    if (record.failureIdentity) return record.failureIdentity;
    if (record.origin || (record.failureFingerprint && record.failureFingerprint !== this.fingerprint(record))) return undefined;
    return { trigger: record.trigger, rootCause: record.rootCause, action: record.action };
  }

  private importReceipts(id: string, receipts: ExperienceExchange['experiences'][number]['receipts']): void {
    for (const receipt of receipts) this.database.prepare('INSERT INTO experience_receipts VALUES (?, ?, ?, ?) ON CONFLICT(experience_id, source_hash) DO NOTHING')
      .run(id, receipt.sourceHash, receipt.runHash, receipt.evidenceHash);
    const count = this.database.prepare("SELECT COUNT(*) AS count FROM experience_receipts WHERE experience_id = ? AND source_hash NOT LIKE 'metric:%'").get(id)!;
    if (Number(count.count) > MAX_RECEIPTS) throw new Error(`Experience source receipt limit reached (${MAX_RECEIPTS})`);
    this.enforceBounds([id]);
  }

  private incrementMetric(id: string, key: keyof ExperienceMetrics): void {
    const row = this.database.prepare("SELECT evidence_hash FROM experience_receipts WHERE experience_id = ? AND source_hash = 'metric:counts'").get(id);
    const counts = row ? metricCountsSchema.parse(JSON.parse(String(row.evidence_hash))) : { retrievals: 0, adoptions: 0, recurrences: 0 };
    counts[key] = Math.min(Number.MAX_SAFE_INTEGER, counts[key] + 1);
    this.database.prepare(`INSERT INTO experience_receipts VALUES (?, 'metric:counts', 'metric', ?)
      ON CONFLICT(experience_id, source_hash) DO UPDATE SET evidence_hash=excluded.evidence_hash`).run(id, JSON.stringify(counts));
  }

  private hash(input: unknown): string {
    return createHash('sha256').update(JSON.stringify(input)).digest('hex');
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Experience store is closed');
  }

  private read(row: { [column: string]: unknown } | undefined): ExperienceRecord | undefined {
    return row ? recordSchema.parse(JSON.parse(String(row.payload))) : undefined;
  }

  private require(id: string): ExperienceRecord {
    const record = this.read(this.database.prepare('SELECT payload FROM experiences WHERE id = ?').get(z.string().uuid().parse(id)));
    if (!record) throw new Error('Experience not found');
    return record;
  }

  private save(input: ExperienceRecord, receipt?: { sourceHash: string; runHash: string; evidenceHash: string }): ExperienceRecord {
    let saturated = false;
    if (receipt) {
      const known = this.database.prepare('SELECT 1 FROM experience_receipts WHERE experience_id = ? AND source_hash = ?').get(input.id, receipt.sourceHash);
      const sources = this.database.prepare("SELECT COUNT(*) AS count FROM experience_receipts WHERE experience_id = ? AND source_hash NOT LIKE 'metric:%'").get(input.id)!;
      saturated = !known && Number(sources.count) >= MAX_RECEIPTS;
    }
    const record = recordSchema.parse(saturated ? { ...input, provenanceSaturated: true,
      status: input.status === 'revoked' ? 'revoked' : 'candidate',
      verifiedEvidence: input.status === 'revoked' ? input.verifiedEvidence : undefined,
    } : input);
    const payload = JSON.stringify(record);
    const bytes = Buffer.byteLength(payload);
    if (bytes > MAX_RECORD_BYTES) throw new Error('Experience exceeds record byte limit');
    this.database.prepare(`INSERT INTO experiences(id, fingerprint, scope, status, updated_at, expires_at, bytes, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint, status=excluded.status, updated_at=excluded.updated_at, expires_at=excluded.expires_at, bytes=excluded.bytes, payload=excluded.payload`)
      .run(record.id, record.fingerprint, record.scope, record.status, record.updatedAt, record.expiresAt, bytes, payload);
    if (receipt && !saturated) {
      this.database.prepare(`INSERT INTO experience_receipts(experience_id, source_hash, run_hash, evidence_hash) VALUES (?, ?, ?, ?)
        ON CONFLICT(experience_id, source_hash) DO UPDATE SET evidence_hash=excluded.evidence_hash`)
        .run(record.id, receipt.sourceHash, receipt.runHash, receipt.evidenceHash);
    }
    this.enforceBounds([record.id]);
    return record;
  }

  private enforceBounds(protectedIds: string[]): void {
    for (;;) {
      const stats = this.database.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0)
        + (SELECT COUNT(*) * 384 FROM experience_receipts)
        + (SELECT COUNT(*) * 256 FROM experience_verifications)
        + (SELECT COALESCE(SUM(length(CAST(payload AS BLOB)) + 256), 0) FROM experience_applicability) AS bytes FROM experiences`).get()!;
      if (Number(stats.count) <= MAX_RECORDS && Number(stats.bytes) <= MAX_BYTES) break;
      this.database.prepare(`DELETE FROM experiences WHERE id = (SELECT id FROM experiences WHERE id NOT IN (${protectedIds.map(() => '?').join(',')}) ORDER BY
        (expires_at > ?) ASC, CASE status WHEN 'candidate' THEN 0 WHEN 'revoked' THEN 1 ELSE 2 END, updated_at, id LIMIT 1)`)
        .run(...protectedIds, this.timestamp());
    }
  }
}
