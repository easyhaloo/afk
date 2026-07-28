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
 */
export function extractACFromLabels(labels: readonly string[]): string[] {
  const items = new Map<number, string>();
  for (const label of labels) {
    const parsed = parseACLabel(label);
    if (parsed) items.set(parsed.index, parsed.text);
  }
  return Array.from(items.entries())
    .sort(([a], [b]) => a - b)
    .map(([, text]) => text);
}

/**
 * Extract AC items from issue description markdown (legacy path).
 * Best-effort parsing of `## AC` / `## Acceptance Criteria` sections
 * with `- [ ] item` lists. Returns null if no AC section found.
 */
export function parseACLegacy(description: string): string[] | null {
  const acMatch = description.match(
    /##\s*(?:AC|Acceptance Criteria)\s*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/i
  );
  if (!acMatch) return null;

  const acText = acMatch[1].trim();
  const items: string[] = [];
  const itemRegex = /^[-*]\s+\[\s*\]\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(acText)) !== null) {
    items.push(match[1].trim());
  }
  return items.length > 0 ? items : null;
}

/**
 * Unified AC extraction: prefer label-based, fall back to legacy markdown.
 * Returns { items, source } so callers can tell which path produced the result.
 */
export function extractAC(issue: Pick<TrackedIssue, 'labels' | 'description'>): {
  items: string[];
  source: 'labels' | 'legacy' | 'none';
} {
  const labelItems = extractACFromLabels(issue.labels);
  if (labelItems.length > 0) return { items: labelItems, source: 'labels' };

  const legacyItems = parseACLegacy(issue.description);
  if (legacyItems) return { items: legacyItems, source: 'legacy' };

  return { items: [], source: 'none' };
}