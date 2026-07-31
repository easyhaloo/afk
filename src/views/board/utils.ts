/** Shared helpers used across board view components. */

export function truncate(text: string | undefined, max: number): string {
  if (!text) return '';
  return text.length <= max ? text : text.substring(0, max - 1) + '…';
}

/** Calculate visual width: Chinese/CJK chars = 2, ASCII = 1 */
export function visualWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += char.charCodeAt(0) > 127 ? 2 : 1;
  }
  return width;
}

/** Truncate text by visual width, adding "…" if cut */
export function truncateByVisualWidth(text: string, maxWidth: number): string {
  if (visualWidth(text) <= maxWidth) return text;
  let width = 0;
  let end = 0;
  for (const char of text) {
    const charWidth = char.charCodeAt(0) > 127 ? 2 : 1;
    if (width + charWidth > maxWidth - 1) break;
    width += charWidth;
    end++;
  }
  return text.substring(0, end) + '…';
}

export function formatRelativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 1) return '<1h';
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
