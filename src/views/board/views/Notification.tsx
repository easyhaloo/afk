import React from 'react';
import { Box, Text } from 'ink';
interface Props {
  notification: { message: string } | null;
  animation: 'hidden' | 'slide-in' | 'visible' | 'slide-out';
}

export function Notification({ notification, animation }: Props) {
  if (!notification) return null;

  return (
    <Box
      position="absolute"
      bottom={1}
      right={3}
      borderStyle="round"
      borderColor="white"
      paddingX={1}
      backgroundColor="black"
    >
      <Text color="white">* </Text>
      <Text dimColor={animation === 'slide-out'}>{notification.message}</Text>
    </Box>
  );
}
