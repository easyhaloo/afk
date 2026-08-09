import React from 'react';
import { Box, Text } from 'ink';

interface Props {
  logs: string[];
}

export function DebugOverlay({ logs }: Props) {
  return (
    <Box
      position="absolute"
      bottom={1}
      left={0}
      right={0}
      height={8}
      backgroundColor="black"
      flexDirection="column"
      paddingX={1}
      borderStyle="round"
      borderColor="cyan"
    >
      <Box flexShrink={0} paddingY={0}>
        <Text color="cyan" bold>▼ DEBUG LOG (Ctrl+D to close)</Text>
      </Box>
      <Box flexDirection="column" overflow="hidden">
        {logs.map((line, i) => (
          <Text key={i} color="cyan" dimColor={i < logs.length - 3}>{line}</Text>
        ))}
      </Box>
    </Box>
  );
}
