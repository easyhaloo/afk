import type { TrackedIssue } from './types';

/**
 * AC is represented as issue labels with prefix `ac::`.
 * Each AC item becomes one label: `ac::1::User can log in`.
 *
 * Why labels, not markdown description parsing?
 *   - Structure: GitLab/GitHub APIs return labels as a typed array.
 *   - Queryable: listIssues({ labels: ['ac::1::...'] }) filters server-side.
 *   - No regex fragility: markdown `- [ ]` variations / Chinese headings /
 *     indented sub-items / unknown syntax all break regex parsing.
 *   - Atomic: append/remove individual AC via standard label APIs.
 *
 * Migration: existing issues with `## AC` markdown sections still work —
 * see parseACLegacy() below; the Runner prefers label AC when present
 * and falls back to legacy parsing otherwise.
 */

const AC_LABEL_PREFIX = 'ac::';

/** Build the label string for AC item N (1-indexed). */
export function buildACLabel(index: number, text: string): string {
  return `${AC_LABEL_PREFIX}${index}::${text}`;
}

/** Parse `ac::N::text` into { index, text } or null. */
export function parseACLabel(label: string): { index: number; text: string } | null {
  if (!label.startsWith(AC_LABEL_PREFIX)) return null;
  const rest = label.slice(AC_LABEL_PREFIX.length);
  const sep = rest.indexOf('::');
  if (sep < 0) return null;
  const index = parseInt(rest.slice(0, sep), 10);
  if (!Number.isFinite(index) || index < 1) return null;
  const text = rest.slice(sep + 2).trim();
  if (text.length === 0) return null;
  return { index, text };
}

/**
 * Extract AC items from issue labels.
 * Returns items sorted by index. Empty array if no AC labels.
 * Label-based AC has no evidence fields (evidenceType='none').
 */
export function extractACFromLabels(labels: readonly string[]): ACItem[] {
  const items = new Map<number, string>();
  for (const label of labels) {
    const parsed = parseACLabel(label);
    if (parsed) items.set(parsed.index, parsed.text);
  }
  return Array.from(items.entries())
    .sort(([a], [b]) => a - b)
    .map(([index, text]): ACItem => ({
      index,
      text,
      evidenceType: 'none',
      checkCommand: '',
    }));
}

/** Controlled evidence types per docs/ISSUE-TEMPLATE.md */
export const EVIDENCE_TYPES = ['test', 'curl', 'log', 'manual', 'none'] as const;
export type EvidenceType = typeof EVIDENCE_TYPES[number];

/**
 * Parsed AC item. `text` is the human-readable condition; `evidenceType`
 * and `checkCommand` enable machine verification.
 */
export interface ACItem {
  index: number;
  text: string;
  evidenceType: EvidenceType;
  checkCommand: string;
}

/**
 * Extract AC items from issue description markdown.
 *
 * Supports both:
 *   - Authoritative 3-field format: `- [ ] <text> -- <type> -- <command>`
 *     (see docs/ISSUE-TEMPLATE.md)
 *   - Legacy simple format: `- [ ] <text>` (best-effort; evidenceType=none,
 *     checkCommand=empty)
 *
 * Returns null if no AC section found.
 */
export function parseACLegacy(description: string): ACItem[] | null {
  const acMatch = description.match(
    /##\s*(?:AC|Acceptance Criteria)(?:\s*\([^)]+\))?\s*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/i
  );
  if (!acMatch) return null;

  const acText = acMatch[1].trim();
  const items: ACItem[] = [];
  const itemRegex = /^[-*]\s+\[\s\]\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  let idx = 1;
  while ((match = itemRegex.exec(acText)) !== null) {
    const raw = match[1].trim();
    const parts = raw.split(/\s+--\s+/);
    if (parts.length === 3 && (EVIDENCE_TYPES as readonly string[]).includes(parts[1])) {
      items.push({
        index: idx++,
        text: parts[0],
        evidenceType: parts[1] as EvidenceType,
        checkCommand: parts[2],
      });
    } else {
      // Legacy: just text, no evidence fields
      items.push({
        index: idx++,
        text: raw,
        evidenceType: 'none',
        checkCommand: '',
      });
    }
  }
  return items.length > 0 ? items : null;
}

/**
 * Unified AC extraction: prefer label-based, fall back to legacy markdown.
 * Returns { items, source } so callers can tell which path produced the result.
 */
export function extractAC(issue: Pick<TrackedIssue, 'labels' | 'description'>): {
  items: ACItem[];
  source: 'labels' | 'legacy' | 'none';
} {
  const labelItems = extractACFromLabels(issue.labels);
  if (labelItems.length > 0) return { items: labelItems, source: 'labels' };

  const legacyItems = parseACLegacy(issue.description);
  if (legacyItems) return { items: legacyItems, source: 'legacy' };

  return { items: [], source: 'none' };
}