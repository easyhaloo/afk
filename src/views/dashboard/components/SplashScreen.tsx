import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import * as nf from '@m234/nerd-fonts';

interface SplashScreenProps {
  onComplete: () => void;
  duration?: number;
}

export const SplashScreen: React.FC<SplashScreenProps> = ({ onComplete, duration = 2500 }) => {
  const [frame, setFrame] = useState(0);
  const [fadeOut, setFadeOut] = useState(false);
  const [skipped, setSkipped] = useState(false);

  // Smoother progress with more frames
  const totalFrames = 30;
  const progress = Math.min(100, Math.floor((frame / totalFrames) * 100));

  // Animated spinner with smooth rotation
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const spinnerIndex = frame % spinnerFrames.length;

  // Progress bar with smooth filling and wave effect
  const barWidth = 32;
  const filledWidth = Math.floor((progress / 100) * barWidth);

  // Create wave effect on progress bar edge
  const waveChars = ['░', '▒', '▓', '█'];
  const waveIndex = frame % waveChars.length;
  const edgeChar = filledWidth < barWidth && filledWidth > 0 ? waveChars[waveIndex] : '';

  const progressBar =
    '█'.repeat(Math.max(0, filledWidth - 1)) +
    edgeChar +
    '░'.repeat(Math.max(0, barWidth - filledWidth - (edgeChar ? 1 : 0)));

  // Enhanced messages with Nerd Fonts icons
  const messages = [
    {
      text: 'Initializing workspace...',
      icon: nf.icons['nf-fa-rocket'].value //
    },
    {
      text: 'Loading configuration...',
      icon: nf.icons['nf-fa-cog'].value //
    },
    {
      text: 'Connecting to GitHub...',
      icon: nf.icons['nf-dev-github_badge'].value //
    },
    {
      text: 'Connecting to GitLab...',
      icon: nf.icons['nf-dev-gitlab'].value //
    },
    {
      text: 'Preparing dashboard...',
      icon: nf.icons['nf-md-view_dashboard'].value // 󰕰
    },
    {
      text: 'Ready to work!',
      icon: nf.icons['nf-fa-check_circle'].value //
    },
  ];

  const messageIndex = Math.min(
    Math.floor((frame / totalFrames) * messages.length),
    messages.length - 1
  );
  const currentMessage = messages[messageIndex];

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      setSkipped(true);
      setFadeOut(true);
      setTimeout(onComplete, 300);
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
          // Longer fade out for smooth transition
          setTimeout(onComplete, 500);
          return prev;
        }
        return prev + 1;
      });
    }, frameInterval);

    return () => clearInterval(timer);
  }, [duration, onComplete, skipped]);

  // Smooth fade in effect for logo (first 25% of animation)
  const logoFadeProgress = Math.min(1, frame / (totalFrames * 0.25));
  const showLogo = logoFadeProgress > 0.2;

  // Pulsing effect on logo (subtle)
  const pulsePhase = Math.sin((frame / totalFrames) * Math.PI * 4) * 0.15 + 0.85;

  // Smooth fade out with easing
  const fadeOutProgress = fadeOut ? Math.max(0, 1 - (frame / 10)) : 1;
  const opacity = fadeOutProgress * pulsePhase;

  // Slide up effect for completion
  const slideOffset = fadeOut ? Math.floor((1 - fadeOutProgress) * 3) : 0;

  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" height="100%">
      {/* Logo with fade-in and subtle pulse */}
      {showLogo && (
        <Box
          flexDirection="column"
          alignItems="center"
          marginBottom={2}
          marginTop={slideOffset}
        >
          <Text bold color="cyan" dimColor={opacity < 0.7}>╔═══════════════════════════════════════╗</Text>
          <Text bold color="cyan" dimColor={opacity < 0.7}>║                                       ║</Text>
          <Text bold color="cyan" dimColor={opacity < 0.7}>║    <Text color="cyanBright">█████╗ ███████╗██╗  ██╗</Text>     ║</Text>
          <Text bold color="cyan" dimColor={opacity < 0.7}>║   <Text color="cyanBright">██╔══██╗██╔════╝██║ ██╔╝</Text>     ║</Text>
          <Text bold color="cyan" dimColor={opacity < 0.7}>║   <Text color="cyanBright">███████║█████╗  █████╔╝</Text>      ║</Text>
          <Text bold color="cyan" dimColor={opacity < 0.7}>║   <Text color="cyanBright">██╔══██║██╔══╝  ██╔═██╗</Text>      ║</Text>
          <Text bold color="cyan" dimColor={opacity < 0.7}>║   <Text color="cyanBright">██║  ██║██║     ██║  ██╗</Text>     ║</Text>
          <Text bold color="cyan" dimColor={opacity < 0.7}>║   <Text color="cyanBright">╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝</Text>     ║</Text>
          <Text bold color="cyan" dimColor={opacity < 0.7}>║                                       ║</Text>
          <Text bold color="cyan" dimColor={opacity < 0.7}>║   <Text dimColor color="gray">Away From Keyboard</Text>            ║</Text>
          <Text bold color="cyan" dimColor={opacity < 0.7}>║                                       ║</Text>
          <Text bold color="cyan" dimColor={opacity < 0.7}>╚═══════════════════════════════════════╝</Text>
        </Box>
      )}

      {/* Loading indicator with animated spinner and Nerd Fonts icon */}
      <Box
        flexDirection="column"
        alignItems="center"
        marginBottom={2}
        marginTop={slideOffset}
      >
        <Box marginBottom={1}>
          <Text color="cyan" dimColor={opacity < 0.7}>
            {spinnerFrames[spinnerIndex]}
          </Text>
          <Text> </Text>
          <Text color="cyanBright" dimColor={opacity < 0.7}>{currentMessage.icon}</Text>
          <Text> </Text>
          <Text dimColor={opacity < 0.7}>{currentMessage.text}</Text>
        </Box>

        {/* Smooth progress bar with wave effect */}
        <Box flexDirection="column" alignItems="center">
          <Box marginBottom={0}>
            <Text color="cyan" dimColor={opacity < 0.7}>[</Text>
            <Text color="cyanBright" dimColor={opacity < 0.7}>{progressBar}</Text>
            <Text color="cyan" dimColor={opacity < 0.7}>]</Text>
          </Box>
          <Text dimColor color="gray">{progress}%</Text>
        </Box>
      </Box>

      {/* Skip hint with subtle animation */}
      <Box marginTop={1} marginBottom={slideOffset}>
        <Text dimColor color="gray">
          Press <Text color="yellow" bold={frame % 20 < 10}>ESC</Text> to skip
        </Text>
      </Box>
    </Box>
  );
};
