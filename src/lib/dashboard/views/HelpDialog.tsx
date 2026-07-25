import React from 'react';
import { Box, Text } from 'ink';

export function HelpDialog() {
  return (
    <Box
      position="absolute"
      top={3}
      left={8}
      right={8}
      bottom={3}
      borderStyle="round"
      borderColor="white"
      backgroundColor="black"
      flexDirection="column"
      padding={1}
    >
      <Box marginBottom={1}>
        <Text bold color="white">▸ Help ▸</Text>
      </Box>

      <Text color="gray">view switch:</Text>
      <Text color="white">  1 - tasks     2 - issues</Text>
      <Text color="white">  3 - done     4 - projects</Text>

      <Box marginTop={1}>
        <Text color="gray">navigate:</Text>
      </Box>
      <Text color="white">  ↑↓ - move</Text>
      <Text color="white">  g/G - top/bottom</Text>

      <Box marginTop={1}>
        <Text color="gray">actions:</Text>
      </Box>
      <Text color="white">  ↵ - detail</Text>
      <Text color="white">  r - refresh</Text>
      <Text color="white">  q - quit</Text>

      <Box marginTop={1}>
        <Text color="gray">tasks:</Text>
      </Box>
      <Text color="white">  a - attach   K - kill</Text>

      <Box marginTop={1}>
        <Text color="gray">issues:</Text>
      </Box>
      <Text color="white">  s - start    o - open</Text>
      <Text color="white">  m - multi select</Text>

      <Box marginTop={1}>
        <Text color="gray">projects:</Text>
      </Box>
      <Text color="white">  ↵ - detail   o - open</Text>

      <Box marginTop={1} justifyContent="center">
        <Text color="gray">? or ESC to close ( o_o )</Text>
      </Box>
    </Box>
  );
}
