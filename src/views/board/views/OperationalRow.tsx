import React from 'react';
import { Box, Text } from 'ink';
import { getRowColumns } from '../layout.js';

import { displayWidth, truncateByWidth } from '../../shared/display-width.js';

export interface OperationalRowProps {
  width: number;
  selected: boolean;
  status: string;
  statusColor: string;
  mode: string;
  runtimeStatus?: string;
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
  runtimeStatus,
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
        {runtimeStatus && <Text wrap="truncate" dimColor> [{runtimeStatus}]</Text>}
        <Text wrap="truncate" bold> #{id} </Text>
        <Text wrap="truncate">{truncateByWidth(title, titleWidth)}</Text>
        {showSummary && <Text wrap="truncate" dimColor>{summaryPrefix}{truncateByWidth(summary, metadataWidth)}</Text>}
      </Text>
    </Box>
  );
}
