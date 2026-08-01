/**
 * Issue detail scroll math.
 *
 * The IssueDetail panel renders a fixed-height body. When the issue description
 * has more lines than fit, j/k keys scroll the visible window. These pure
 * functions compute the visible window size, the legal scroll range, and
 * clamp a requested offset so the keyboard handler cannot escape bounds.
 *
 * Kept separate from DetailScreen.tsx so it can be unit-tested without
 * rendering the Ink component.
 */

export interface IssueScrollBounds {
  /** How many description lines fit on screen at once. */
  visibleLines: number;
  /** Total description lines (after split('\n')). */
  totalLines: number;
  /** Maximum legal scroll offset. Bottom of the window sits at totalLines. */
  maxScroll: number;
}

/**
 * Body chrome = paddingY (2) + top/bottom borders (2).
 * IssueDetail header = url, labels, state, "description:" header plus the
 * marginTop blank line. Anything left over is description room.
 */
const ISSUE_BODY_CHROME = 4;
const ISSUE_HEADER_LINES = 5;

export function computeIssueScrollBounds(
  bodyHeight: number,
  totalDescLines: number,
): IssueScrollBounds {
  const visibleLines = Math.max(0, bodyHeight - ISSUE_BODY_CHROME - ISSUE_HEADER_LINES);
  const maxScroll = Math.max(0, totalDescLines - visibleLines);
  return { visibleLines, totalLines: totalDescLines, maxScroll };
}

/**
 * Clamp a requested scroll offset to the legal range [0, maxScroll].
 * Used after a key press so the offset cannot overshoot the bounds.
 */
export function clampScrollOffset(offset: number, maxScroll: number): number {
  if (offset < 0) return 0;
  if (offset > maxScroll) return maxScroll;
  return offset;
}
