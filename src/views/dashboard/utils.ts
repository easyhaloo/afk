/** Shared helpers used across dashboard view components. */

export function truncate(text: string | undefined, max: number): string {
  if (!text) return '';
  return text.length <= max ? text : text.substring(0, max - 1) + '…';
}

export function formatRelativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 1) return '<1h';
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
