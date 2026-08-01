import React from 'react';
import { Box, Text } from 'ink';
import { Issue } from '../../../types/board';
import { ListView } from './ListView';
import { renderMarkdown } from '../utils';

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

        // Label display logic per issue #40:
        // - Default (non-selected): show only stage:: labels, collapse others
        // - Selected row: show full labels with dimColor
        // - Truncate at 20 visual width with "+N" suffix
        const stageLabels = issue.labels.filter(l => l.startsWith('stage::'));
        const otherLabels = issue.labels.filter(l => !l.startsWith('stage::'));

        const labelText = isCurrent
          ? issue.labels.join(', ')  // selected: show all labels
          : (stageLabels.length > 0 ? stageLabels.join(', ') : '–');  // non-selected: show stage only

        // Truncate label text at 20 visual width
        const truncatedLabels = truncateByVisualWidth(labelText, 20);
        const needsTruncation = visualWidth(labelText) > 20;
        const displayLabels = needsTruncation
          ? `${truncatedLabels} +${isCurrent ? otherLabels.length : otherLabels.length}`
          : labelText;

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
            <Text dimColor> · {renderMarkdown(issue.description, 40)}</Text>
          </Box>
        );
      }}
    />
  );
}
