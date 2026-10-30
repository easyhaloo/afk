import type { TrackedIssue } from './types.js';
import type { ACItem, AcceptanceCriteria, EvidenceType } from './ac-types.js';
import { EVIDENCE_TYPES } from './ac-types.js';

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

/**
 * Extract AC items from issue description markdown.
 *
 * Supports both:
 *   - Authoritative 3-field format: `- [ ] <text> -- <type> -- <command>`
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
  // Split by lookahead of '- [ ]' or '* [ ]' at line start (each item starts with checkbox).
  const itemTexts = acText.split(/(?=^[-*]\s+\[)/m).filter(Boolean);
  const items: ACItem[] = [];
  let idx = 1;
  for (const block of itemTexts) {
    const firstLine = block.split('\n')[0];
    const checkboxMatch = firstLine.match(/^[-*]\s+\[\s\]\s+(.+)$/);
    if (!checkboxMatch) continue;
    const raw = checkboxMatch[1].trim();
    const verifyLines = block.split('\n').slice(1).map(l => l.trim()).filter(l => l.startsWith('_verify:'));
    const verifyCommand = verifyLines.map(l => l.replace(/^_verify:\s*/, '')).join('; ');
    const parsed = parseThreeFieldAC(raw);
    if (parsed) {
      items.push({ index: idx++, text: parsed.text, evidenceType: parsed.evidenceType, checkCommand: parsed.checkCommand });
    } else if (verifyCommand) {
      items.push({ index: idx++, text: raw, evidenceType: 'bash', checkCommand: verifyCommand });
    } else {
      items.push({ index: idx++, text: raw, evidenceType: 'none', checkCommand: '' });
    }
  }
  return items.length > 0 ? items : null;
}

/**
 * Parse the authoritative three-field form `- [ ] <text> -- <type> -- <command>`.
 *
 * The type field is the anchor: it has to be one of the known evidence types,
 * so a `--` inside the text or inside the command cannot be mistaken for the
 * separator. The command may be absent — `- [ ] <text> -- manual` is a
 * criterion only a person can settle.
 *
 * Returns null when the line is not in the three-field form at all.
 */
export function parseThreeFieldAC(raw: string): { text: string; evidenceType: EvidenceType; checkCommand: string } | null {
  const separator = /\s+--\s+/g;
  const parts: string[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = separator.exec(raw)) !== null) {
    parts.push(raw.slice(last, match.index));
    last = match.index + match[0].length;
  }
  parts.push(raw.slice(last));

  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts[i + 1].trim().toLowerCase();
    if (!isEvidenceType(candidate)) continue;
    const text = parts.slice(0, i + 1).join(' -- ').trim();
    if (!text) return null;
    const checkCommand = parts.slice(i + 2).join(' -- ').trim();
    return { text, evidenceType: candidate, checkCommand };
  }
  return null;
}

function isEvidenceType(value: string): value is EvidenceType {
  return (EVIDENCE_TYPES as readonly string[]).includes(value);
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
