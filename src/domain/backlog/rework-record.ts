export type ReworkSource = 'qa';
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

export interface ReworkRecord {
  version: 1;
  id: string;
  attempt: number;
  status: ReworkStatus;
  source: ReworkSource;
  summary: string;
  failedCriteria: ReworkCriterion[];
  requiredChecks: RequiredReworkCheck[];
  createdAt: string;
  resolvedAt?: string;
  resolutionSummary?: string;
}

export type NewReworkRecord = Omit<ReworkRecord, 'version' | 'id' | 'attempt' | 'status' | 'createdAt' | 'resolvedAt' | 'resolutionSummary'>;
export interface ReworkResolution { summary: string; }

export interface ParsedReworkRecord { commentId: string; record: ReworkRecord; }

export function renderReworkRecord(record: ReworkRecord): string {
  return [
    `<!-- afk:rework:v1 id=${record.id} -->`,
    '',
    `## AFK Rework ${record.id} · ${record.status}`,
    '',
    record.summary,
    '',
    '```json',
    JSON.stringify(record),
    '```',
  ].join('\n');
}

export function parseReworkRecord(comment: { id: string; body: string }): ParsedReworkRecord | undefined {
  const marker = /<!--\s*afk:rework:v1\s+id=(r\d+)\s*-->/i.exec(comment.body);
  const payload = /```json\s*\n([\s\S]*?)\n```/i.exec(comment.body);
  if (!marker || !payload) return undefined;
  try {
    const value = JSON.parse(payload[1]) as Partial<ReworkRecord>;
    if (
      value.version !== 1 || value.id !== marker[1] || !Number.isInteger(value.attempt) || value.attempt! < 1 ||
      !isStatus(value.status) || value.source !== 'qa' || !nonEmpty(value.summary) || !Array.isArray(value.failedCriteria) ||
      !Array.isArray(value.requiredChecks) || !nonEmpty(value.createdAt)
    ) return undefined;
    return { commentId: comment.id, record: value as ReworkRecord };
  } catch {
    return undefined;
  }
}

export function latestOpenRework(comments: Array<{ id: string; body: string }>): ParsedReworkRecord | undefined {
  return comments
    .map(parseReworkRecord)
    .filter((entry): entry is ParsedReworkRecord => entry !== undefined && entry.record.status === 'open')
    .sort((left, right) => right.record.attempt - left.record.attempt)[0];
}

function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function isStatus(value: unknown): value is ReworkStatus { return value === 'open' || value === 'resolved' || value === 'superseded'; }
