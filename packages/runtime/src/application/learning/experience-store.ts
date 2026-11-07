import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { redactUtf8 } from '../../infrastructure/observability/local-evidence-store.js';
import { openSqlite, transaction, type SqliteDatabase } from '../../infrastructure/storage/sqlite.js';

const MAX_RECORDS = 1000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_BYTES = 32 * 1024;
const MAX_RECEIPTS = 256;
const DAY = 24 * 60 * 60 * 1000;

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
const recordSchema = failureSchema.omit({ expiresAt: true }).extend({
  id: z.string().uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  failureFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  status: statusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  occurrences: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  observations: z.array(observationSchema).min(1).max(8),
  verifiedEvidence: verificationSchema.extend({ verifiedAt: z.string().datetime() }).optional(),
  provenanceSaturated: z.boolean().optional(),
}).strict();

export type ExperienceStatus = z.infer<typeof statusSchema>;
export type RecordFailureInput = z.input<typeof failureSchema>;
export type ExperienceVerification = z.input<typeof verificationSchema>;
export type ExperienceRecord = z.infer<typeof recordSchema>;
export interface ExperienceStoreOptions { file: string; now?: () => Date }

const verificationHistorySchema = `
CREATE TABLE experience_verifications (
  experience_id TEXT NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
  run_hash TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  PRIMARY KEY(experience_id, run_hash)
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
`;

export class ExperienceStore {
  private readonly database: SqliteDatabase;
  private readonly now: () => Date;
  private closed = false;

  constructor(options: ExperienceStoreOptions) {
    const parsed = z.object({ file: text(4096), now: z.function().optional() }).strict().parse(options);
    this.now = options.now ?? (() => new Date());
    this.timestamp();
    this.database = openSqlite({ file: parsed.file, schema, durability: 'FULL', version: 2,
      migrations: [{ from: 1, to: 2, migrate: database => {
        database.exec(verificationHistorySchema);
        for (const row of database.prepare('SELECT payload FROM experiences').all()) {
          const record = this.read(row)!;
          if (record.verifiedEvidence) database.prepare('INSERT INTO experience_verifications VALUES (?, ?, ?)')
            .run(record.id, this.hash(record.verifiedEvidence.runId), this.hash([...record.verifiedEvidence.evidence].sort()));
        }
      } }],
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
        return this.save({ ...parsed, id: randomUUID(), fingerprint, failureFingerprint: fingerprint, status: 'candidate', createdAt: now, updatedAt: now,
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
      return this.save({ ...existing, status: existing.status === 'revoked' ? 'revoked' : keepVerified ? 'verified' : 'candidate',
        verifiedEvidence: existing.status === 'revoked' || keepVerified ? existing.verifiedEvidence : undefined,
        evidence: [...new Set([...existing.evidence, ...parsed.evidence])].slice(-8), observations: observations.slice(-8),
        occurrences: existing.occurrences + (seen || previous ? 0 : 1), updatedAt: now,
        expiresAt: expired ? expiry : existing.expiresAt }, receipt);
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

  recall(input: { scope: string; prompt: string; limit?: number; maxChars?: number }): ExperienceRecord[] {
    this.assertOpen();
    const parsed = z.object({ scope: identity, prompt: text(8192), limit: z.number().int().min(0).max(100).default(5),
      maxChars: z.number().int().min(0).max(MAX_RECORD_BYTES).default(8000) }).strict().parse(input);
    const terms = [...new Set(redact(parsed.prompt).toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [])]
      .filter(term => !['the', 'and', 'for', 'with', 'this', 'that', 'please', 'fix'].includes(term));
    if (!terms.length || !parsed.limit || parsed.maxChars < 2) return [];
    const candidates = this.database.prepare('SELECT payload FROM experiences WHERE scope = ? AND status = ? AND expires_at > ?')
      .all(parsed.scope, 'verified', this.timestamp()).map(row => this.read(row)!)
      .map(record => {
        const content = `${record.trigger} ${record.rootCause} ${record.action}`.toLowerCase();
        const words = new Set(content.match(/[\p{L}\p{N}_]{2,}/gu) ?? []);
        return { record, score: terms.filter(term => words.has(term)).length };
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
    return selected;
  }

  verify(id: string, input: ExperienceVerification): ExperienceRecord {
    this.assertOpen();
    const parsed = verificationSchema.parse(input);
    return transaction(this.database, () => {
      const record = this.require(id);
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
      const corrected = { ...record, failureFingerprint: record.failureFingerprint ?? record.fingerprint, action: parsed.action ?? record.action, rootCause: parsed.rootCause ?? record.rootCause };
      const fingerprint = this.fingerprint(corrected);
      const conflict = this.database.prepare("SELECT id FROM experiences WHERE (fingerprint = ? OR json_extract(payload, '$.failureFingerprint') = ?) AND id <> ?").get(fingerprint, fingerprint, record.id);
      if (conflict) throw new Error('Corrected experience already exists');
      if (record.status === 'verified' && record.verifiedEvidence?.runId === parsed.runId
        && record.fingerprint === fingerprint && JSON.stringify(record.verifiedEvidence.evidence) === JSON.stringify(parsed.evidence)) return record;
      const runHash = this.hash(parsed.runId);
      const evidenceHash = this.hash([...parsed.evidence].sort());
      if (this.database.prepare('SELECT 1 FROM experience_verifications WHERE experience_id = ? AND (run_hash = ? OR evidence_hash = ?)')
        .get(record.id, runHash, evidenceHash)) throw new Error('Verification requires a fresh run and evidence');
      const verifications = this.database.prepare('SELECT COUNT(*) AS count FROM experience_verifications WHERE experience_id = ?').get(record.id)!;
      if (Number(verifications.count) >= MAX_RECEIPTS) throw new Error(`Experience verification limit reached (${MAX_RECEIPTS})`);
      this.database.prepare('INSERT INTO experience_verifications VALUES (?, ?, ?)').run(record.id, runHash, evidenceHash);
      return this.save({ ...corrected, fingerprint, status: 'verified', updatedAt: now, verifiedEvidence: { ...parsed, verifiedAt: now } });
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

  private fingerprint(input: Pick<ExperienceRecord, 'scope' | 'trigger' | 'rootCause' | 'action'>): string {
    return this.hash([input.scope, input.trigger, input.rootCause, input.action]);
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
      const sources = this.database.prepare('SELECT COUNT(*) AS count FROM experience_receipts WHERE experience_id = ?').get(input.id)!;
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
    for (;;) {
      const stats = this.database.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0)
        + (SELECT COUNT(*) * 384 FROM experience_receipts)
        + (SELECT COUNT(*) * 256 FROM experience_verifications) AS bytes FROM experiences`).get()!;
      if (Number(stats.count) <= MAX_RECORDS && Number(stats.bytes) <= MAX_BYTES) break;
      this.database.prepare(`DELETE FROM experiences WHERE id = (SELECT id FROM experiences WHERE id <> ? ORDER BY
        (expires_at > ?) ASC, CASE status WHEN 'candidate' THEN 0 WHEN 'revoked' THEN 1 ELSE 2 END, updated_at, id LIMIT 1)`)
        .run(record.id, this.timestamp());
    }
    return record;
  }
}
