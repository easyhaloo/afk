/** Shared helpers used across board view components. */

import React from 'react';
import { Text } from 'ink';

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
  const ellipsisWidth = visualWidth('…'); // ellipsis is 2 visual width
  if (visualWidth(text) <= maxWidth) return text;
  let width = 0;
  let end = 0;
  for (const char of text) {
    const charWidth = char.charCodeAt(0) > 127 ? 2 : 1;
    // Break if adding this char would make total exceed available space (maxWidth - ellipsisWidth)
    if (width + charWidth > maxWidth - ellipsisWidth) break;
    width += charWidth;
    end++;
  }
  return text.substring(0, end) + '…';
}

/**
 * Parse a single line of markdown and return Ink React nodes.
 * Handles: ## headings (bold), **bold**, *italic*, - lists, 1. ordered lists
 * Returns null if no markdown was found, letting callers fall back to plain text.
 */
export function parseMarkdownLine(line: string): React.ReactNode[] | null {
  // Quick check — nothing to do if line lacks markdown markers
  if (!line.includes('#') && !line.includes('*') && !line.includes('-') && !line.includes('1.')) {
    return null;
  }

  const parts: React.ReactNode[] = [];
  let remaining = line;
  let key = 0;

  while (remaining.length > 0) {
    // ## Heading (bold, leading ## stripped)
    const headingMatch = remaining.match(/^(#{2,6})\s+(.*)/);
    if (headingMatch) {
      parts.push(<Text key={key++} bold>{headingMatch[2]}</Text>);
      remaining = remaining.slice(headingMatch[0].length);
      continue;
    }

    // **bold**
    const boldMatch = remaining.match(/^\*\*(.+?)\*\*/);
    if (boldMatch) {
      parts.push(<Text key={key++} bold>{boldMatch[1]}</Text>);
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // *italic* (but not **)
    const italicMatch = remaining.match(/^\*(?!\*)(.+?)\*/);
    if (italicMatch) {
      parts.push(<Text key={key++} italic>{italicMatch[1]}</Text>);
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // - list item (but not ---)
    const listMatch = remaining.match(/^-\s+(.*)/);
    if (listMatch) {
      const nested = parseMarkdownLine(listMatch[1]);
      parts.push(nested
        ? <Text key={key++}>• {nested}</Text>
        : <Text key={key++}>• {listMatch[1]}</Text>);
      remaining = remaining.slice(listMatch[0].length);
      continue;
    }

    // 1. ordered list item
    const orderedMatch = remaining.match(/^\d+\.\s+(.*)/);
    if (orderedMatch) {
      const nested = parseMarkdownLine(orderedMatch[1]);
      parts.push(nested
        ? <Text key={key++}>· {nested}</Text>
        : <Text key={key++}>· {orderedMatch[1]}</Text>);
      remaining = remaining.slice(orderedMatch[0].length);
      continue;
    }

    // Plain text — consume one character at a time to handle mixed content
    const next = remaining[0];
    parts.push(next);
    remaining = remaining.slice(1);
  }

  return parts.length > 0 && parts.some(p => typeof p !== 'string') ? parts : null;
}

/**
 * Render a markdown string into Ink Text nodes (first line only, for list view).
 * Returns the original text if no markdown is detected.
 */
export function renderMarkdown(text: string | undefined, max: number): React.ReactNode {
  if (!text) return '…';

  // Check first line (descriptions often start with ## headings)
  const firstLine = text.split('\n')[0];
  const trimmed = firstLine.trim();

  if (!trimmed) return '…';

  const parsed = parseMarkdownLine(trimmed);
  if (parsed) {
    // Apply truncation to the rendered markdown
    const plainText = truncate(text, max);
    return <>{parsed}</>;
  }

  // No markdown detected — use plain truncated text
  return truncate(text, max);
}

export function formatRelativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 1) return '<1h';
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
