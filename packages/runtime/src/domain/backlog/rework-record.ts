/**
 * Who asked for the rework.
 *
 * 'conflict' is not a QA failure: the change request could not be merged
 * because the target branch changed the same lines.
 */
export type ReworkSource = 'qa' | 'operator' | 'conflict';
export type ReworkStatus = 'open' | 'resolved' | 'superseded';

export interface ReworkCriterion {
  id: string;
  expected: string;
  actual: string;
}

export interface RequiredReworkCheck {
  command: string;
  expected: string;
}

/**
 * One correction of a rework record's summary.
 *
 * A rework record states what was wrong when it was written. That statement
 * can go stale: the dependency it waited for has since been produced, or the
 * branch it complained about has since moved. A revision says what the
 * statement is now — and keeps what it was, so the record is corrected rather
 * than overwritten.
 */
export interface ReworkRevision {
  /** When the correction was written. */
  at: string;
  /** Who wrote the correction. */
  actor: string;
  /** The summary before the correction. */
  from: string;
  /** The summary after the correction. */
  to: string;
  /** Why the statement was corrected. */
  reason?: string;
}

export interface ReworkRecord {
  version: 1;
  /**
   * The handle of the record, unique inside one backlog item.
   *
   * It is `r<cycle>-<attempt>`, so a reader of the issue history can tell the
   * round of work a record belongs to without reading its body.
   */
  id: string;
  /**
   * The rework cycle this record belongs to.
   *
   * Cycle 1 is the item's first round of fix-and-verify. A cycle is opened by
   * an operator retry, so the cycle number says which round of human
   * involvement the record came from.
   */
  cycle: number;
  /**
   * The attempt inside the cycle.
   *
   * It counts the retries the cycle has spent: a QA failure and a merge
   * conflict each spend one. The operator record that opens a cycle spends
   * none, so it carries attempt 0 and the cycle's first QA failure is attempt
   * 1.
   */
  attempt: number;
  status: ReworkStatus;
  source: ReworkSource;
  summary: string;
  failedCriteria: ReworkCriterion[];
  requiredChecks: RequiredReworkCheck[];
  createdAt: string;
  resolvedAt?: string;
  resolutionSummary?: string;
  /**
   * The corrections applied to `summary`, oldest first.
   *
   * They belong to the record: a record that has been corrected says what it
   * said before, who corrected it, and when. The evidence the record carries
   * — `failedCriteria` and `requiredChecks` — is never touched by a
   * correction; only the statement about the current situation is.
   */
  revisions?: ReworkRevision[];
}

export type NewReworkRecord = Omit<ReworkRecord, 'version' | 'id' | 'cycle' | 'attempt' | 'status' | 'createdAt' | 'resolvedAt' | 'resolutionSummary' | 'revisions'>;
export interface ReworkResolution { summary: string; }

export interface ParsedReworkRecord { commentId: string; record: ReworkRecord; }

export function renderReworkRecord(record: ReworkRecord): string {
  return [
    `<!-- afk:rework:v1 id=${record.id} -->`,
    '',
    `## AFK Rework ${record.id} · ${record.status}`,
    '',
    record.summary,
    ...renderRevisionHistory(record.revisions),
    '',
    '```json',
    JSON.stringify(record),
    '```',
  ].join('\n');
}

/**
 * The corrections of a record, as a person reads them.
 *
 * The JSON payload is the machine-readable truth; this is the same trail in
 * prose, so a reader of the issue does not have to parse the payload to find
 * out that the summary was corrected, by whom and when.
 */
function renderRevisionHistory(revisions: readonly ReworkRevision[] | undefined): string[] {
  if (!revisions?.length) return [];
  return [
    '',
    '### Revisions',
    '',
    ...revisions.map(revision => {
      const reason = revision.reason ? ` — ${revision.reason}` : '';
      return `- ${revision.at} by ${revision.actor}: ${revision.from} → ${revision.to}${reason}`;
    }),
  ];
}

export function parseReworkRecord(comment: { id: string; body: string }): ParsedReworkRecord | undefined {
  const marker = /<!--\s*afk:rework:v1\s+id=(r[\d-]+)\s*-->/i.exec(comment.body);
  const payload = /```json\s*\n([\s\S]*?)\n```/i.exec(comment.body);
  if (!marker || !payload) return undefined;
  try {
    const value = JSON.parse(payload[1]) as Partial<ReworkRecord>;
    if (
      value.version !== 1 || value.id !== marker[1] || !Number.isInteger(value.attempt) || value.attempt! < 0 ||
      !isStatus(value.status) || !isSource(value.source) || !nonEmpty(value.summary) || !Array.isArray(value.failedCriteria) ||
      !Array.isArray(value.requiredChecks) || !nonEmpty(value.createdAt)
    ) return undefined;
    // A record written before cycles existed belongs to the first cycle and
    // keeps the attempt it was written with, so an item that already spent
    // its budget stays over budget until an operator opens a new cycle.
    const cycle = value.cycle === undefined ? 1 : value.cycle;
    if (!Number.isInteger(cycle) || cycle < 1) return undefined;
    // A revision trail is the audit trail of a corrected statement, so a
    // malformed entry makes the record unreadable rather than dropping the
    // entry: a half-read trail would hide the correction.
    const revisions = value.revisions === undefined ? undefined : parseRevisions(value.revisions);
    if (value.revisions !== undefined && !revisions) return undefined;
    return {
      commentId: comment.id,
      record: { ...(value as ReworkRecord), cycle, ...(revisions ? { revisions } : {}) },
    };
  } catch {
    return undefined;
  }
}

/** The revision trail of a record, or undefined when it is malformed. */
function parseRevisions(value: unknown): ReworkRevision[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const revisions: ReworkRevision[] = [];
  for (const entry of value) {
    const candidate = entry as Partial<ReworkRevision>;
    if (!nonEmpty(candidate.at) || !nonEmpty(candidate.actor) || !nonEmpty(candidate.from) || !nonEmpty(candidate.to)) {
      return undefined;
    }
    if (candidate.reason !== undefined && !nonEmpty(candidate.reason)) return undefined;
    revisions.push({
      at: candidate.at,
      actor: candidate.actor,
      from: candidate.from,
      to: candidate.to,
      ...(candidate.reason !== undefined ? { reason: candidate.reason } : {}),
    });
  }
  return revisions;
}

export function latestOpenRework(comments: Array<{ id: string; body: string }>): ParsedReworkRecord | undefined {
  return comments
    .map(parseReworkRecord)
    .filter((entry): entry is ParsedReworkRecord => entry !== undefined && entry.record.status === 'open')
    .sort((left, right) => compareReworkRecords(right.record, left.record))[0];
}

/**
 * Order rework records by the round they belong to, then by their position
 * inside it.
 *
 * A newer cycle always wins, and inside a cycle the higher attempt is the
 * later record. The creation time only breaks a tie, so the order does not
 * depend on the provider returning comments in any particular order.
 */
export function compareReworkRecords(left: ReworkRecord, right: ReworkRecord): number {
  if (left.cycle !== right.cycle) return left.cycle - right.cycle;
  if (left.attempt !== right.attempt) return left.attempt - right.attempt;
  return left.createdAt.localeCompare(right.createdAt);
}

/** The handle of a rework record: unique inside one backlog item. */
export function reworkRecordId(cycle: number, attempt: number): string {
  return `r${cycle}-${attempt}`;
}

/**
 * The cycle and the attempt a new rework record takes.
 *
 * A rework cycle is one round of fix-and-verify, and the cycle owns the retry
 * budget: `maxQaReworkAttempts` bounds how many times AFK may try again
 * inside one round without asking a person.
 *
 * An operator retry opens a new cycle. The operator has answered the failure
 * that ended the previous round and says that something changed, so the round
 * that failed is over and the next one starts with a full budget. A QA
 * failure or a merge conflict does not open a cycle: it is another try inside
 * the round that is already running, and it shares that round's budget.
 *
 * The history is read only to find the cycle that is running now, so a closed
 * record keeps its place in the audit trail without spending the budget of the
 * rounds that follow it.
 */
export function nextReworkAttempt(
  records: readonly ReworkRecord[],
  source: ReworkSource,
): { cycle: number; attempt: number } {
  const running = records.reduce((highest, record) => Math.max(highest, record.cycle), 0);
  if (source === 'operator') return { cycle: running + 1, attempt: 0 };
  const cycle = running || 1;
  const spent = records
    .filter(record => record.cycle === cycle)
    .reduce((highest, record) => Math.max(highest, record.attempt), 0);
  return { cycle, attempt: spent + 1 };
}

function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function isSource(value: unknown): value is ReworkSource { return value === 'qa' || value === 'operator' || value === 'conflict'; }
function isStatus(value: unknown): value is ReworkStatus { return value === 'open' || value === 'resolved' || value === 'superseded'; }
