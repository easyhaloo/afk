import React from 'react';
import { Box, Text } from 'ink';

interface Props<T> {
  items: T[];
  selected: number;
  scrollOffset: number;
  viewportHeight: number;
  emptyMessage: string;
  getKey: (item: T, index: number) => string | number;
  render: (item: T, index: number, isSelected: boolean) => React.ReactNode;
}

export function ListView<T>({
  items, selected, scrollOffset, viewportHeight,
  emptyMessage, getKey, render,
}: Props<T>) {
  if (items.length === 0) {
    return (
      <Box justifyContent="center" alignItems="center" height="100%">
        <Text color="gray">  {emptyMessage}</Text>
      </Box>
    );
  }

  const visible = items.slice(scrollOffset, scrollOffset + viewportHeight);
  // Flex column lets the selection border stretch to full width. Each item
  // grows (flexGrow=1) so visible items distribute evenly across the column
  // height, eliminating the trailing whitespace when items.length < viewport.
  return (
    <Box flexDirection="column" flexGrow={1} alignItems="stretch">
      {visible.map((item, i) => {
        const index = scrollOffset + i;
        const node = render(item, index, index === selected);
        // Wrap rendering in a Box with flexGrow=1 so the slot stretches to
        // fill its share of the column. We justifyContent=center so compact
        // single-line content stays vertically centered in its tall slot.
        return (
          <Box key={getKey(item, index)} flexGrow={1} flexShrink={0} justifyContent="flex-start">
            {node}
          </Box>
        );
      })}
    </Box>
  );
}
