/**
 * How wide a string is in a column, and how to cut it to fit.
 *
 * A full-width character — CJK, Hangul, Kana, the full-width forms — takes
 * two columns and everything else takes one, so a string's width is not its
 * length.  Two board views were measuring it themselves, each with the same
 * table of ranges in it, and each cutting the text its own way.
 */

/** Whether a code point takes two columns. */
export function isFullWidthCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2329 && codePoint <= 0x232a) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

/** How many columns a string takes. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    width += isFullWidthCodePoint(character.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return width;
}

const ELLIPSIS = '…';
const ELLIPSIS_WIDTH = displayWidth(ELLIPSIS);

/**
 * Cut a string to a column budget, marking the cut with an ellipsis.
 */
export function truncateByWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0 || displayWidth(text) <= maxWidth) return maxWidth > 0 ? text : '';
  if (maxWidth < ELLIPSIS_WIDTH) return '';

  let width = 0;
  let result = '';
  for (const character of text) {
    const charWidth = displayWidth(character);
    if (width + charWidth > maxWidth - ELLIPSIS_WIDTH) break;
    result += character;
    width += charWidth;
  }
  return result + ELLIPSIS;
}
