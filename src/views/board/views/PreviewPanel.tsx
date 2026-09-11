import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { BacklogViewModel } from '../data/backlog-adapter';
import { truncate } from '../utils';

interface Props {
  backlog: BacklogViewModel | undefined;
  width: number;
}

const MIN_WIDTH = 100;

function wrapText(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (!paragraph.trim()) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(' ')) {
      if (`${line} ${word}`.trim().length <= maxWidth) line = `${line} ${word}`.trim();
      else {
        if (line) lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function stateColor(state: BacklogViewModel['state']): string {
  if (state === 'blocked') return 'red';
  if (state === 'in_progress') return 'yellow';
  if (state === 'verification') return 'magenta';
  if (state === 'done') return 'green';
  return 'cyan';
}

export const PreviewPanel: React.FC<Props> = ({ backlog, width }) => {
  const previewWidth = Math.floor(width * 0.4);
  const content = useMemo(() => {
    if (!backlog) return <Box paddingX={1}><Text dimColor italic>no backlog selected</Text></Box>;

    const description = wrapText(backlog.description || 'no description', previewWidth - 4);
    return (
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        <Text bold color="cyan" wrap="wrap">{backlog.title}</Text>
        <Box marginTop={1}>
          <Text dimColor>backlog {backlog.id} · </Text>
          <Text color={stateColor(backlog.state)} bold>{backlog.state}</Text>
          <Text dimColor> · </Text>
          <Text color="cyan">{backlog.executionMode}</Text>
        </Box>
        <Text dimColor>branch: {backlog.branchName}</Text>
        {backlog.tags.length > 0 && <Text dimColor>tags: {backlog.tags.join(', ')}</Text>}
        <Box marginTop={1}><Text dimColor>{'─'.repeat(Math.min(previewWidth - 4, 40))}</Text></Box>
        <Box marginTop={1} flexDirection="column" flexGrow={1}>
          <Text dimColor>description:</Text>
          {description.slice(0, 20).map((line, index) => <Text key={index}>{line}</Text>)}
        </Box>
        {backlog.webUrl && <Box marginTop={1}><Text dimColor italic wrap="wrap">{truncate(backlog.webUrl, previewWidth - 4)}</Text></Box>}
      </Box>
    );
  }, [backlog, previewWidth]);

  if (width < MIN_WIDTH) return null;
  return (
    <Box flexDirection="column" width={previewWidth} borderStyle="single" borderColor="gray">
      <Box paddingX={1}><Text bold color="gray">preview</Text></Box>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">{content}</Box>
    </Box>
  );
};
