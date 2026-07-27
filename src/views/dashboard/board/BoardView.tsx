import React from 'react';
import { Box, Text } from 'ink';
import { Issue } from '../../../types/dashboard';

/**
 * BoardView - Kanban board view for issues
 *
 * Supports mixed GitLab and GitHub issues in a single board.
 * Issues are grouped by stage labels into columns: Open, In Progress, Blocked, Done.
 */

interface BoardColumn {
  title: string;
  issues: Issue[];
  color: string;
}

interface BoardViewProps {
  issues: Issue[];
  selectedIndex: number;
  scrollOffset: number;
  viewportHeight: number;
}

/**
 * Group issues by column based on labels
 */
function groupIssuesByColumn(issues: Issue[]): Record<string, BoardColumn> {
  const columns: Record<string, BoardColumn> = {
    open: { title: 'Open', issues: [], color: 'cyan' },
    'in-progress': { title: 'In Progress', issues: [], color: 'yellow' },
    blocked: { title: 'Blocked', issues: [], color: 'red' },
    done: { title: 'Done', issues: [], color: 'green' },
  };

  for (const issue of issues) {
    if (issue.labels.includes('stage::afk-in-progress') || issue.labels.includes('in-progress')) {
      columns['in-progress'].issues.push(issue);
    } else if (issue.labels.includes('blocked')) {
      columns.blocked.issues.push(issue);
    } else if (issue.labels.includes('stage::qa') || issue.labels.includes('done') || issue.state === 'closed') {
      columns.done.issues.push(issue);
    } else {
      columns.open.issues.push(issue);
    }
  }

  return columns;
}

export const BoardView: React.FC<BoardViewProps> = ({
  issues,
  selectedIndex,
  scrollOffset,
  viewportHeight,
}) => {
  const columns = groupIssuesByColumn(issues);
  const columnKeys = ['open', 'in-progress', 'blocked', 'done'];

  // Flatten issues for selection indexing
  const flatIssues: Array<{ issue: Issue; columnKey: string }> = [];
  for (const key of columnKeys) {
    for (const issue of columns[key].issues) {
      flatIssues.push({ issue, columnKey: key });
    }
  }

  const selectedItem = flatIssues[selectedIndex];

  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="row" justifyContent="space-around">
        {columnKeys.map(key => {
          const column = columns[key];
          return (
            <Box key={key} flexDirection="column" width="25%" paddingX={1}>
              <Text bold color={column.color}>
                {column.title} ({column.issues.length})
              </Text>
              <Text color="gray">{'─'.repeat(20)}</Text>
              {column.issues.slice(scrollOffset, scrollOffset + viewportHeight).map((issue) => {
                const isSelected = selectedItem?.issue === issue;

                return (
                  <Box key={issue.iid} marginTop={1}>
                    <Text
                      backgroundColor={isSelected ? 'blue' : undefined}
                      color={isSelected ? 'white' : 'white'}
                    >
                      {isSelected ? '▶ ' : '  '}
                      #{issue.iid} {issue.title.slice(0, 15)}...
                    </Text>
                  </Box>
                );
              })}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};
