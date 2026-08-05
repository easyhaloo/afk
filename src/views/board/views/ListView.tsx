import React from 'react';
import { Box, Text } from 'ink';

export function normalizeRowText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

interface Props<T> {
  items: T[];
  selected: number;
  scrollOffset: number;
  viewportHeight: number;
  width?: number;
  emptyMessage: string;
  getKey: (item: T, index: number) => string | number;
  render: (item: T, index: number, isSelected: boolean) => React.ReactNode;
}

export function ListView<T>({
  items, selected, scrollOffset, viewportHeight,
  width: requestedWidth,
  emptyMessage, getKey, render,
}: Props<T>) {
  const width = requestedWidth || process.stdout.columns || 80;
  if (items.length === 0) {
    return (
      <Box width={width} justifyContent="center" alignItems="center" height="100%">
        <Text color="gray">  {emptyMessage}</Text>
      </Box>
    );
  }

  const visible = items.slice(scrollOffset, scrollOffset + viewportHeight);
  return (
    <Box flexDirection="column" width={width} alignItems="stretch">
      {visible.map((item, i) => {
        const index = scrollOffset + i;
        const node = render(item, index, index === selected);
        return (
          <Box key={getKey(item, index)} flexShrink={0}>
            {node}
          </Box>
        );
      })}
    </Box>
  );
}
