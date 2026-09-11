import React from 'react';
import { Box, Text } from 'ink';
import type { BacklogViewModel } from '../data/backlog-adapter';
import { backlogStateColor } from '../views/BacklogRow';
import { getExecutionModeColor, getExecutionModeIcon, getStatusIcon } from '../views/display';

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

function truncateByWidth(text: string, maxWidth: number): string {
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

export interface BoardCardProps {
  backlog: BacklogViewModel;
  selected: boolean;
  width: number;
}

export function BoardCard({ backlog, selected, width }: BoardCardProps) {
  const stateColor = backlogStateColor(backlog.state);
  const title = truncateByWidth(backlog.title, Math.max(1, width - 2));

  return (
    <Box width={width} height={2} overflow="hidden" flexDirection="column">
      <Text color={selected ? 'white' : stateColor} wrap="truncate">
        {selected ? '▶ ' : '  '}
        <Text color={stateColor}>{getStatusIcon(backlog.state)}</Text>
        <Text bold> #{backlog.id}</Text>
        <Text color={getExecutionModeColor(backlog.executionMode)}> {getExecutionModeIcon(backlog.executionMode)}</Text>
      </Text>
      <Text wrap="truncate" bold={selected}>{title}</Text>
    </Box>
  );
}
