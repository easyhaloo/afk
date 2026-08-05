import React from 'react';
import { Box, Text } from 'ink';
import { getRowColumns } from '../layout';

function isFullWidthCodePoint(codePoint: number): boolean {
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

function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    width += isFullWidthCodePoint(character.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return width;
}

const ELLIPSIS = '…';
const ELLIPSIS_WIDTH = displayWidth(ELLIPSIS);

function truncateToAllocation(text: string, maxWidth: number): string {
  if (maxWidth <= 0 || displayWidth(text) <= maxWidth) return maxWidth > 0 ? text : '';
  if (maxWidth < ELLIPSIS_WIDTH) return '';

  let width = 0;
  let result = '';
  for (const character of text) {
    const characterWidth = displayWidth(character);
    if (width + characterWidth > maxWidth - ELLIPSIS_WIDTH) break;
    result += character;
    width += characterWidth;
  }
  return result + ELLIPSIS;
}

export interface OperationalRowProps {
  width: number;
  selected: boolean;
  status: string;
  statusColor: string;
  mode: string;
  id: string | number;
  title: string;
  summary: string;
}

export function OperationalRow({
  width,
  selected,
  status,
  statusColor,
  mode,
  id,
  title,
  summary,
}: OperationalRowProps) {
  const { summary: showSummary, metadataWidth } = getRowColumns(width);
  const marker = selected ? '▶ ' : '  ';
  const prefix = `${marker}[${status}] (${mode}) #${id} `;
  const summaryPrefix = showSummary ? ' · ' : '';
  const titleWidth = Math.max(
    0,
    width - displayWidth(prefix) - displayWidth(summaryPrefix) - (showSummary ? metadataWidth : 0),
  );

  return (
    <Box width={width} height={1} overflow="hidden">
      <Text wrap="truncate">
        <Text wrap="truncate">{marker}</Text>
        <Text wrap="truncate" color={statusColor}>[{status}]</Text>
        <Text wrap="truncate" dimColor> ({mode})</Text>
        <Text wrap="truncate" bold> #{id} </Text>
        <Text wrap="truncate">{truncateToAllocation(title, titleWidth)}</Text>
        {showSummary && <Text wrap="truncate" dimColor>{summaryPrefix}{truncateToAllocation(summary, metadataWidth)}</Text>}
      </Text>
    </Box>
  );
}
