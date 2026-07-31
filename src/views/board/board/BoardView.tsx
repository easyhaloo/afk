import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { Issue } from '../../../types/board';
import { PreviewPanel } from '../views/PreviewPanel';

/**
 * BoardView - Split-panel board: left 60% issue list + right 40% preview
 *
 * Replaces the old kanban 4-column layout with a list+preview layout.
 * Preview shows selected issue's title, description, labels, state.
 * Preview auto-hides when terminal width < 100 columns.
 */
interface BoardViewProps {
  issues: Issue[];
  selectedIndex: number;
  scrollOffset: number;
  viewportHeight: number;
  width?: number;
}

function getIssueStage(issue: Issue): { label: string; color: string } {
  if (issue.labels.includes('stage::afk-in-progress') || issue.labels.includes('in-progress')) {
    return { label: 'in-progress', color: 'yellow' };
  }
  if (issue.labels.includes('blocked')) {
    return { label: 'blocked', color: 'red' };
  }
  if (issue.labels.includes('stage::qa') || issue.labels.includes('done') || issue.state === 'closed') {
    return { label: 'done', color: 'green' };
  }
  return { label: 'open', color: 'cyan' };
}

export const BoardView: React.FC<BoardViewProps> = ({
  issues,
  selectedIndex,
  scrollOffset,
  viewportHeight,
  width: parentWidth,
}) => {
  const [W, setW] = useState(parentWidth || process.stdout.columns || 80);

  useEffect(() => {
    if (parentWidth) { setW(parentWidth); return; }
    const id = setInterval(() => {
      const c = process.stdout.columns || 80;
      setW(prev => prev !== c ? c : prev);
    }, 500);
    return () => clearInterval(id);
  }, [parentWidth]);

  const LIST_W = W >= 100 ? Math.floor(W * 0.6) : W;
  const selectedIssue = issues[selectedIndex];

  return (
    <Box flexDirection="row" width={W} flexGrow={1}>
      {/* Left: Issue list */}
      <Box flexDirection="column" width={LIST_W} flexGrow={1}>
        <Text bold color="cyan">board · {issues.length} issues</Text>
        <Text dimColor>{'─'.repeat(Math.min(LIST_W - 2, 50))}</Text>
        {issues.length === 0 && <Text dimColor italic>no issues</Text>}
        {issues.slice(scrollOffset, scrollOffset + viewportHeight).map((issue, idx) => {
          const globalIdx = scrollOffset + idx;
          const isSelected = globalIdx === selectedIndex;
          const stage = getIssueStage(issue);
          return (
            <Box key={issue.iid} flexDirection="row" alignItems="flex-start" overflow="hidden">
              <Text
                backgroundColor={isSelected ? 'blue' : undefined}
                color={isSelected ? 'white' : stage.color}
                bold={isSelected}
                width="100%"
                wrap="truncate"
              >
                {isSelected ? '▶ ' : '  '}
                <Text color={stage.color} dimColor>[{stage.label}]</Text>
                {' '}{issue.title}
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* Right: Preview */}
      {W >= 100 && (
        <Box flexGrow={1} flexDirection="row">
          <Box flexDirection="column" justifyContent="flex-start" paddingX={0}>
            <Text dimColor>{'│'}</Text>
          </Box>
          <PreviewPanel issue={selectedIssue} width={W} />
        </Box>
      )}
    </Box>
  );
};
