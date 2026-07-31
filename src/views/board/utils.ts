/** Shared helpers used across board view components. */

/** Returns true if the code point is displayed at 2 terminal cells (full-width / CJK). */
function isFullWidth(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3040 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe1f) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x2fffe) ||
    (cp >= 0x30000 && cp <= 0x3fffe)
  );
}

/** Returns the visual width of a string in terminal cells. */
function strWidth(text: string): number {
  let width = 0;
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    width += isFullWidth(cp) ? 2 : 1;
    if (cp > 0xffff) i++; // skip surrogate pair
  }
  return width;
}

export function truncate(text: string | undefined, max: number): string {
  if (!text) return '';
  if (strWidth(text) <= max) return text;

  let width = 0;
  let byteOffset = 0;
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    const charWidth = isFullWidth(cp) ? 2 : 1;
    // Stop if adding this character would exceed available space (max - 1 for the ellipsis)
    if (width + charWidth + 1 > max) break;
    width += charWidth;
    byteOffset += cp > 0xffff ? 2 : 1;
    if (cp > 0xffff) i++; // skip surrogate pair
  }
  return text.slice(0, byteOffset) + '…';
}

export function formatRelativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 1) return '<1h';
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
