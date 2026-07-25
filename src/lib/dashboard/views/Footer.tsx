import React from 'react';
import { Box, Text } from 'ink';

export function Footer() {
  return (
    <Box
      height={1}
      flexShrink={0}
      paddingX={1}
      backgroundColor="black"
      justifyContent="center"
      alignItems="center"
    >
      <Text>
        <Text color="gray">ESC</Text>
        <Text color="white"> back │ </Text>
        <Text color="gray">?</Text>
        <Text color="white"> help │ </Text>
        <Text color="gray">↑↓</Text>
        <Text color="white"> │ </Text>
        <Text color="gray">o</Text>
        <Text color="white"> open │ </Text>
        <Text color="gray">r</Text>
        <Text color="white"> │ </Text>
      </Text>
    </Box>
  );
}
