import React from 'react';
import { Box, Text } from 'ink';
import { Issue } from '../../../types/dashboard';
import { ListView } from './ListView';

interface Props {
  issues: Issue[];
  selected: number;
  scrollOffset: number;
  viewportHeight: number;
  multiSelectMode: boolean;
  selectedIssues: Set<number>;
}

export function IssueListView({
  issues, selected, scrollOffset, viewportHeight,
  multiSelectMode, selectedIssues,
}: Props) {
  return (
    <ListView
      items={issues}
      selected={selected}
      scrollOffset={scrollOffset}
      viewportHeight={viewportHeight}
      emptyMessage="ℹ  no issues"
      getKey={(issue) => `${issue.iid}-${issue.web_url}`}
      render={(issue, index, isCurrent) => {
        const isSelected = selectedIssues.has(issue.iid);
        const checkbox = multiSelectMode ? (isSelected ? '☒' : '☐') : '○';
        const color = isCurrent ? 'white' : 'gray';
        return (
          <Box
            key={issue.iid}
            width="100%"
            overflow="hidden"
            flexDirection="row"
            borderStyle={isCurrent ? 'round' : undefined}
            borderColor={isCurrent ? 'white' : undefined}
            paddingX={1}
            backgroundColor={isSelected ? 'gray' : undefined}
          >
            <Text color={color}>{checkbox} </Text>
            <Text color={color} bold> #{issue.iid} </Text>
            <Text color={color}>{issue.title}</Text>
            <Text dimColor>  ─ {issue.labels.length > 0 ? issue.labels.join(', ') : '–'}</Text>
            <Text dimColor> · {issue.description ? truncate(issue.description, 40) : '…'}</Text>
          </Box>
        );
      }}
    />
  );
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 3) + '…';
}
