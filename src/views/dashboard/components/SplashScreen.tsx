import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';

interface SplashScreenProps {
  onComplete: () => void;
  duration?: number;
}

export const SplashScreen: React.FC<SplashScreenProps> = ({ onComplete, duration = 2500 }) => {
  const [frame, setFrame] = useState(0);
  const [fadeOut, setFadeOut] = useState(false);
  const [skipped, setSkipped] = useState(false);

  // Smoother progress with more frames
  const totalFrames = 25;
  const progress = Math.min(100, Math.floor((frame / totalFrames) * 100));

  // Animated spinner
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const spinnerIndex = frame % spinnerFrames.length;

  // Progress bar with smooth filling
  const barWidth = 30;
  const filledWidth = Math.floor((progress / 100) * barWidth);
  const progressBar = '█'.repeat(filledWidth) + '░'.repeat(barWidth - filledWidth);

  const messages = [
    'Initializing workspace...',
    'Loading configuration...',
    'Connecting to GitHub...',
    'Connecting to GitLab...',
    'Ready to work!',
  ];

  const messageIndex = Math.min(
    Math.floor((frame / totalFrames) * messages.length),
    messages.length - 1
  );

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      setSkipped(true);
      setFadeOut(true);
      setTimeout(onComplete, 200);
    }
  });

  useEffect(() => {
    if (skipped) return;

    const frameInterval = duration / totalFrames;
    const timer = setInterval(() => {
      setFrame((prev) => {
        if (prev >= totalFrames - 1) {
          clearInterval(timer);
          setFadeOut(true);
          setTimeout(onComplete, 400);
          return prev;
        }
        return prev + 1;
      });
    }, frameInterval);

    return () => clearInterval(timer);
  }, [duration, onComplete, skipped]);

  // Fade in effect for logo (first 20% of animation)
  const logoOpacity = Math.min(1, frame / (totalFrames * 0.2));
  const showLogo = logoOpacity > 0.3;

  // Fade out effect
  const opacity = fadeOut ? 0.3 : 1;

  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" height="100%">
      {/* Logo with fade-in */}
      {showLogo && (
        <Box flexDirection="column" alignItems="center" marginBottom={2}>
          <Text bold color="cyan" dimColor={opacity < 1}>╔═══════════════════════════════════════╗</Text>
          <Text bold color="cyan" dimColor={opacity < 1}>║                                       ║</Text>
          <Text bold color="cyan" dimColor={opacity < 1}>║    <Text color="cyanBright">█████╗ ███████╗██╗  ██╗</Text>     ║</Text>
          <Text bold color="cyan" dimColor={opacity < 1}>║   <Text color="cyanBright">██╔══██╗██╔════╝██║ ██╔╝</Text>     ║</Text>
          <Text bold color="cyan" dimColor={opacity < 1}>║   <Text color="cyanBright">███████║█████╗  █████╔╝</Text>      ║</Text>
          <Text bold color="cyan" dimColor={opacity < 1}>║   <Text color="cyanBright">██╔══██║██╔══╝  ██╔═██╗</Text>      ║</Text>
          <Text bold color="cyan" dimColor={opacity < 1}>║   <Text color="cyanBright">██║  ██║██║     ██║  ██╗</Text>     ║</Text>
          <Text bold color="cyan" dimColor={opacity < 1}>║   <Text color="cyanBright">╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝</Text>     ║</Text>
          <Text bold color="cyan" dimColor={opacity < 1}>║                                       ║</Text>
          <Text bold color="cyan" dimColor={opacity < 1}>║   <Text dimColor color="gray">Away From Keyboard</Text>            ║</Text>
          <Text bold color="cyan" dimColor={opacity < 1}>║                                       ║</Text>
          <Text bold color="cyan" dimColor={opacity < 1}>╚═══════════════════════════════════════╝</Text>
        </Box>
      )}

      {/* Loading indicator with spinner */}
      <Box flexDirection="column" alignItems="center" marginBottom={2}>
        <Box marginBottom={1}>
          <Text color="cyan" dimColor={opacity < 1}>
            {spinnerFrames[spinnerIndex]}
          </Text>
          <Text> </Text>
          <Text dimColor={opacity < 1}>{messages[messageIndex]}</Text>
        </Box>

        {/* Smooth progress bar */}
        <Box flexDirection="column" alignItems="center">
          <Text color="cyan" dimColor={opacity < 1}>{progressBar}</Text>
          <Text dimColor color="gray">{progress}%</Text>
        </Box>
      </Box>

      {/* Skip hint */}
      <Box marginTop={1}>
        <Text dimColor color="gray">
          Press <Text color="yellow">ESC</Text> to skip
        </Text>
      </Box>
    </Box>
  );
};
