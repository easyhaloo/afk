/**
 * PreviewPanel - Right-side preview panel for selected issue
 *
 * Shows: title, description, labels, state.
 * Adapts to window width; hidden when W < 100.
 */
import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { Issue } from '../../../types/board';
import { truncate } from '../utils';

interface Props {
  issue: Issue | undefined;
  width: number; // total terminal width
  /** Called when content updates to allow parent to measure flicker */
  onUpdated?: () => void;
}

const MIN_WIDTH = 100; // minimum columns to show preview

/**
 * Wrap text to a given width (simple word-break)
 */
function wrapText(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  const paragraphs = text.split('\n');
  for (const para of paragraphs) {
    if (!para.trim()) { lines.push(''); continue; }
    const words = para.split(' ');
    let current = '';
    for (const word of words) {
      if ((current + ' ' + word).trim().length <= maxWidth) {
        current = (current + ' ' + word).trim();
      } else {
        if (current) lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

function renderDescription(text: string | undefined, maxWidth: number): React.ReactNode {
  if (!text) return <Text dimColor>no description</Text>;
  const lines = wrapText(text, maxWidth);
  return (
    <Box flexDirection="column">
      {lines.slice(0, 20).map((line, i) => (
        <Text key={i} color="white">{line}</Text>
      ))}
      {lines.length > 20 && <Text dimColor>… ({lines.length - 20} more lines)</Text>}
    </Box>
  );
}

export const PreviewPanel: React.FC<Props> = ({ issue, width }) => {
  const previewWidth = Math.floor(width * 0.4);
  const showPreview = width >= MIN_WIDTH;

  const content = useMemo(() => {
    if (!issue) {
      return (
        <Box paddingX={1} paddingY={0} flexDirection="column">
          <Text dimColor italic>no issue selected</Text>
        </Box>
      );
    }

    const stateColor = issue.state === 'closed' ? 'green'
      : issue.state === 'open' ? 'cyan' : 'yellow';

    return (
      <Box flexDirection="column" paddingX={1} paddingY={0} flexGrow={1}>
        {/* Title */}
        <Text bold color="cyan" wrap="wrap">{issue.title}</Text>

        {/* Issue ID + State */}
        <Box marginTop={1}>
          <Text dimColor>#{issue.iid}</Text>
          <Text dimColor> · </Text>
          <Text color={stateColor} bold>{issue.state}</Text>
        </Box>

        {/* Labels */}
        {issue.labels.length > 0 && (
          <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
            <Text dimColor>labels: </Text>
            {issue.labels.map(label => (
              <Text key={label} color="magenta" dimColor> [{label}]</Text>
            ))}
          </Box>
        )}

        {/* Separator */}
        <Box marginTop={1}>
          <Text dimColor>{'─'.repeat(Math.min(previewWidth - 4, 40))}</Text>
        </Box>

        {/* Description */}
        <Box marginTop={1} flexDirection="column" flexGrow={1}>
          <Text dimColor>description:</Text>
          <Box marginTop={0} flexDirection="column">
            {renderDescription(issue.description, previewWidth - 4)}
          </Box>
        </Box>

        {/* Web URL */}
        {issue.web_url && (
          <Box marginTop={1}>
            <Text dimColor italic wrap="wrap">{truncate(issue.web_url, previewWidth - 4)}</Text>
          </Box>
        )}
      </Box>
    );
  }, [issue, previewWidth]);

  if (!showPreview) return null;

  return (
    <Box
      flexDirection="column"
      width={previewWidth}
      borderStyle="single"
      borderColor="gray"
      paddingX={0}
      paddingY={0}
    >
      <Box paddingX={1} paddingY={0}>
        <Text bold color="gray">preview</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {content}
      </Box>
    </Box>
  );
};
