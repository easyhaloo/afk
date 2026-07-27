import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';

interface SplashScreenProps {
  onComplete: () => void;
  duration?: number;
}

export const SplashScreen: React.FC<SplashScreenProps> = ({ onComplete, duration = 2500 }) => {
  const [frame, setFrame] = useState(0);
  const [skipped, setSkipped] = useState(false);

  const frames = [
    '▱▱▱▱▱▱▱▱▱▱',
    '▰▱▱▱▱▱▱▱▱▱',
    '▰▰▱▱▱▱▱▱▱▱',
    '▰▰▰▱▱▱▱▱▱▱',
    '▰▰▰▰▱▱▱▱▱▱',
    '▰▰▰▰▰▱▱▱▱▱',
    '▰▰▰▰▰▰▱▱▱▱',
    '▰▰▰▰▰▰▰▱▱▱',
    '▰▰▰▰▰▰▰▰▱▱',
    '▰▰▰▰▰▰▰▰▰▱',
    '▰▰▰▰▰▰▰▰▰▰',
  ];

  const messages = [
    'Initializing afk...',
    'Loading configuration...',
    'Connecting to services...',
    'Ready!',
  ];

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      setSkipped(true);
      onComplete();
    }
  });

  useEffect(() => {
    if (skipped) return;

    const frameInterval = duration / frames.length;
    const timer = setInterval(() => {
      setFrame((prev) => {
        if (prev >= frames.length - 1) {
          clearInterval(timer);
          setTimeout(onComplete, 300);
          return prev;
        }
        return prev + 1;
      });
    }, frameInterval);

    return () => clearInterval(timer);
  }, [duration, onComplete, skipped, frames.length]);

  const messageIndex = Math.min(
    Math.floor((frame / frames.length) * messages.length),
    messages.length - 1
  );

  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" height="100%">
      <Box marginBottom={2}>
        <Text bold color="cyan">
          ╔═══════════════════════════╗
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          ║         AFK  CLI         ║
        </Text>
      </Box>
      <Box marginBottom={2}>
        <Text bold color="cyan">
          ╚═══════════════════════════╝
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text>{frames[frame]}</Text>
      </Box>
      <Box marginBottom={2}>
        <Text dimColor>{messages[messageIndex]}</Text>
      </Box>
      <Box>
        <Text dimColor color="gray">
          Press ESC to skip
        </Text>
      </Box>
    </Box>
  );
};
