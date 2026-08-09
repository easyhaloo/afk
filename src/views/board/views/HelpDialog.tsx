import React from 'react';
import { Box, Text } from 'ink';
import type { View } from '../types';

interface Props {
  view?: View;
  detail?: boolean;
  canOpen?: boolean;
  canAttach?: boolean;
}

export function HelpDialog({ view = 'tasks', detail = false, canOpen = false, canAttach = false }: Props) {
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
      <Text color="gray">actions:</Text>
      {detail && <Text color="white">  b/ESC back</Text>}
      {!detail && <Text color="white">  Enter - detail</Text>}
      {!detail && <Text color="white">  r - refresh</Text>}
      {providerView && canOpen && <Text color="white">  o - open provider URL</Text>}
      {view === 'tasks' && canOpen && <Text color="white">  o - open task diagnostics</Text>}
      {view === 'tasks' && canAttach && <Text color="white">  a - attach interactive task</Text>}
      <Text color="white">  Ctrl+D - debug overlay</Text>
      <Box marginTop={1} justifyContent="center"><Text color="gray">? or ESC to close</Text></Box>
    </Box>
  );
}
