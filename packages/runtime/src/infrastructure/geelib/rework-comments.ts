/**
 * The rework-record comment protocol of the geelib provider.
 *
 * The platform's comments are append-only HTML rich text: AFK can append a
 * comment but never edit or trust a deletion, so a rework record cannot be
 * corrected in place the way the git providers do it. Instead every state
 * change appends one comment whose machine-readable truth sits inside HTML
 * comments (which the platform never renders) and whose human-readable body
 * follows the reconciliation-note style.
 *
 * One comment body carries two markers:
 *
 * - the state marker `<!-- afk:rework:<recordId>:<state> -->` with `state`
 *   one of `open` / `resolved` / `superseded` / `revision`;
 * - the data marker `<!-- afk:rework:<recordId>:data:<json> -->` carrying the
 *   full record (open), the resolution (resolved) or the single revision
 *   entry (revision) as JSON.
 *
 * Reading folds the comment sequence back into records: an open marker
 * (re)creates the record, a revision marker folds into the open record it
 * names, and a resolved or superseded marker closes it. A record is active
 * when it is still open — the record a later create superseded is closed by
 * its superseded marker, so exactly the newest open record is active, the
 * same answer the git providers get from `latestOpenRework`.
 */

import type { ReworkRecord, ReworkRevision, ReworkSource } from '../../domain/backlog/rework-record.js';

/** The parsed rework event one comment body carries. */
type ReworkCommentEvent =
  | { kind: 'open'; recordId: string; record: ReworkRecord }
  | { kind: 'resolved'; recordId: string; resolution: ReworkResolutionPayload }
  | { kind: 'superseded'; recordId: string }
  | { kind: 'revision'; recordId: string; revision: ReworkRevision };

interface ReworkResolutionPayload { resolvedAt: string; summary: string; }

const STATE_MARKER = /<!--\s*afk:rework:([A-Za-z0-9_-]+):(open|resolved|superseded|revision)\s*-->/;
const DATA_MARKER = /<!--\s*afk:rework:([A-Za-z0-9_-]+):data:([\s\S]*?)\s*-->/;

const SOURCE_LABELS: Readonly<Record<ReworkSource, string>> = { qa: 'QA', operator: '人工', conflict: '合并冲突' };

/**
 * JSON that is safe inside an HTML comment.
 *
 * A comment ends at the first `-->`, and a summary or a criterion can carry
 * that sequence. `>` cannot appear in JSON output outside a string literal,
 * so escaping every `>` as `\u003E` — a valid JSON string escape — removes
 * every possible comment terminator; `JSON.parse` decodes it back.
 */
function encodePayload(value: unknown): string {
  return JSON.stringify(value).replace(/>/g, '\\u003E');
}

/** One rework comment body: markers first, the human-readable note after. */
function renderComment(recordId: string, state: string, payload: unknown, note: string[]): string {
  const markers = [stateMarker(recordId, state)];
  if (payload !== undefined) markers.push(dataMarker(recordId, payload));
  return [...markers, ...note].join('\n');
}

function stateMarker(recordId: string, state: string): string {
  return `<!-- afk:rework:${recordId}:${state} -->`;
}

function dataMarker(recordId: string, payload: unknown): string {
  return `<!-- afk:rework:${recordId}:data:${encodePayload(payload)} -->`;
}

/** The evidence a record carries, as the human-readable lists under the summary. */
function renderEvidence(record: ReworkRecord): string[] {
  const parts: string[] = [];
  if (record.failedCriteria.length) {
    const items = record.failedCriteria
      .map(criterion => `<li>${escapeHtml(criterion.id)}：期望 ${escapeHtml(criterion.expected)}，实际 ${escapeHtml(criterion.actual)}</li>`)
      .join('');
    parts.push(`<p><strong>未通过的验收标准</strong>：</p><ul>${items}</ul>`);
  }
  if (record.requiredChecks.length) {
    const items = record.requiredChecks
      .map(check => `<li><code>${escapeHtml(check.command)}</code>：${escapeHtml(check.expected)}</li>`)
      .join('');
    parts.push(`<p><strong>必须通过的检查</strong>：</p><ul>${items}</ul>`);
  }
  return parts;
}

export function renderReworkOpenComment(record: ReworkRecord): string {
  return renderComment(record.id, 'open', record, [
    `<p><strong>AFK 返工记录 ${escapeHtml(record.id)}</strong>（cycle ${record.cycle}，attempt ${record.attempt}，来源 ${SOURCE_LABELS[record.source]}）</p>`,
    `<p>${escapeHtml(record.summary)}</p>`,
    ...renderEvidence(record),
  ]);
}

export function renderReworkResolutionComment(recordId: string, resolution: ReworkResolutionPayload): string {
  return renderComment(recordId, 'resolved', resolution, [
    `<p><strong>AFK 返工完成</strong>：${escapeHtml(recordId)} 已解决 — ${escapeHtml(resolution.summary)}</p>`,
  ]);
}

export function renderReworkSupersededComment(recordId: string): string {
  return renderComment(recordId, 'superseded', undefined, [
    `<p><strong>AFK 返工记录 ${escapeHtml(recordId)} 已被更新的返工记录取代</strong></p>`,
  ]);
}

export function renderReworkRevisionComment(recordId: string, revision: ReworkRevision): string {
  const reason = revision.reason ? `（${escapeHtml(revision.reason)}）` : '';
  return renderComment(recordId, 'revision', revision, [
    `<p><strong>AFK 返工更正 ${escapeHtml(recordId)}</strong>：${escapeHtml(revision.from)} → ${escapeHtml(revision.to)}${reason}</p>`,
  ]);
}

/** The rework event one comment body carries, or undefined when it carries none. */
export function parseReworkComment(comment: { id: string; body: string }): ReworkCommentEvent | undefined {
  const state = STATE_MARKER.exec(comment.body);
  if (!state) return undefined;
  const recordId = state[1];
  if (state[2] === 'superseded') return { kind: 'superseded', recordId };
  const data = DATA_MARKER.exec(comment.body);
  if (!data || data[1] !== recordId) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(data[2]);
  } catch {
    return undefined;
  }
  if (state[2] === 'open') {
    const record = parseRecordPayload(payload, recordId);
    return record ? { kind: 'open', recordId, record } : undefined;
  }
  if (state[2] === 'resolved') {
    const resolution = parseResolutionPayload(payload);
    return resolution ? { kind: 'resolved', recordId, resolution } : undefined;
  }
  const revision = parseRevisionPayload(payload);
  return revision ? { kind: 'revision', recordId, revision } : undefined;
}

/**
 * The rework records the comment sequence carries, in creation order.
 *
 * A malformed marker or payload is skipped, not fatal: the comment trail is
 * append-only evidence, and one broken entry must not hide the records
 * around it. A revision, resolution or superseded marker only applies to a
 * record that is currently open, so re-reading the trail is idempotent.
 */
export function reworkHistory(comments: ReadonlyArray<{ id: string; body: string }>): ReworkRecord[] {
  const records = new Map<string, ReworkRecord>();
  for (const comment of comments) {
    const event = parseReworkComment(comment);
    if (!event) continue;
    const record = records.get(event.recordId);
    if (event.kind === 'open') {
      records.set(event.recordId, event.record);
    } else if (!record || record.status !== 'open') {
      continue;
    } else if (event.kind === 'revision') {
      records.set(event.recordId, {
        ...record,
        summary: event.revision.to,
        revisions: [...(record.revisions ?? []), event.revision],
      });
    } else if (event.kind === 'resolved') {
      records.set(event.recordId, {
        ...record,
        status: 'resolved',
        resolvedAt: event.resolution.resolvedAt,
        resolutionSummary: event.resolution.summary,
      });
    } else {
      records.set(event.recordId, { ...record, status: 'superseded' });
    }
  }
  return [...records.values()];
}

/** The record the item's rework routing must act on, if any. */
export function activeRework(comments: ReadonlyArray<{ id: string; body: string }>): ReworkRecord | undefined {
  const open = reworkHistory(comments).filter(record => record.status === 'open');
  return open.length ? open[open.length - 1] : undefined;
}

// ── Payload validation ──────────────────────────────────────────────────────
//
// The same shape rules the domain's `parseReworkRecord` applies, minus the
// markdown fence this protocol replaces.

function parseRecordPayload(value: unknown, recordId: string): ReworkRecord | undefined {
  const record = value as Partial<ReworkRecord> | null;
  if (
    !record || record.version !== 1 || record.id !== recordId || record.status !== 'open' ||
    !Number.isInteger(record.attempt) || record.attempt! < 0 ||
    !Number.isInteger(record.cycle) || record.cycle! < 1 ||
    !isSource(record.source) || !nonEmpty(record.summary) ||
    !Array.isArray(record.failedCriteria) || !Array.isArray(record.requiredChecks) ||
    !nonEmpty(record.createdAt)
  ) return undefined;
  return record as ReworkRecord;
}

function parseResolutionPayload(value: unknown): ReworkResolutionPayload | undefined {
  const resolution = value as Partial<ReworkResolutionPayload> | null;
  if (!resolution || !nonEmpty(resolution.resolvedAt) || !nonEmpty(resolution.summary)) return undefined;
  return { resolvedAt: resolution.resolvedAt, summary: resolution.summary };
}

function parseRevisionPayload(value: unknown): ReworkRevision | undefined {
  const revision = value as Partial<ReworkRevision> | null;
  if (
    !revision || !nonEmpty(revision.at) || !nonEmpty(revision.actor) ||
    !nonEmpty(revision.from) || !nonEmpty(revision.to)
  ) return undefined;
  if (revision.reason !== undefined && !nonEmpty(revision.reason)) return undefined;
  return {
    at: revision.at,
    actor: revision.actor,
    from: revision.from,
    to: revision.to,
    ...(revision.reason !== undefined ? { reason: revision.reason } : {}),
  };
}

function isSource(value: unknown): value is ReworkSource {
  return value === 'qa' || value === 'operator' || value === 'conflict';
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** The platform comments are HTML rich text; runner text must not smuggle markup in. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
