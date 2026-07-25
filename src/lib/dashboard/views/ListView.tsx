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
  return (
    <>
      {visible.map((item, i) => {
        const index = scrollOffset + i;
        return (
          <React.Fragment key={getKey(item, index)}>
            {render(item, index, index === selected)}
          </React.Fragment>
        );
      })}
    </>
  );
}
