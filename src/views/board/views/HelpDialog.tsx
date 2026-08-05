import React from 'react';
import { Box, Text } from 'ink';
import type { View } from '../types';

interface Props {
  view?: View;
  detail?: boolean;
}

export function HelpDialog({ view = 'tasks', detail = false }: Props) {
  const providerView = view !== 'tasks';

  return (
    <Box position="absolute" top={3} left={8} right={8} bottom={3} borderStyle="round" borderColor="white" backgroundColor="black" flexDirection="column" padding={1}>
      <Box marginBottom={1}><Text bold color="white">▸ Help ▸</Text></Box>
      <Text color="gray">view switch:</Text>
      <Text color="white">  1 - tasks     2 - backlogs</Text>
      <Text color="white">  3 - projects  4 - board</Text>
      {!detail && <>
        <Box marginTop={1}><Text color="gray">navigate:</Text></Box>
        <Text color="white">  ↑↓ - move     g/G - top/bottom</Text>
      </>}
      <Box marginTop={1}><Text color="gray">actions:</Text></Box>
      {detail && <Text color="white">  b/ESC back</Text>}
      {!detail && <Text color="white">  Enter - detail</Text>}
      {!detail && <Text color="white">  r - refresh</Text>}
      {providerView && <Text color="white">  o - open provider URL</Text>}
      {!detail && view === 'tasks' && <Text color="white">  a - attach selected task</Text>}
      <Box marginTop={1} justifyContent="center"><Text color="gray">? or ESC to close</Text></Box>
    </Box>
  );
}
