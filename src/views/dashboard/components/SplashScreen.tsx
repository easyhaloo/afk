/**
 * SplashScreen - Animated loading screen with real loading phases
 */
import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import type { LoadingPhase } from '../hooks/useLoadingPhase';

interface SplashScreenProps {
  phases: LoadingPhase[];
  onComplete: () => void;
}

export const SplashScreen: React.FC<SplashScreenProps> = ({ phases, onComplete }) => {
  const [fadeOut, setFadeOut] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [frame, setFrame] = useState(0);

  // Only show phases that have been made visible by the loading hook
  const visiblePhases = phases.filter(p => p.visible);
  const totalPhases = visiblePhases.length;
  const doneCount = visiblePhases.filter(p => p.done).length;
  const progress = totalPhases > 0 ? Math.floor((doneCount / totalPhases) * 100) : 0;

  // Current active phase (first non-done among visible phases)
  const currentPhase = visiblePhases.find(p => !p.done) || visiblePhases[visiblePhases.length - 1];

  // Animated spinner
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const spinnerIndex = frame % spinnerFrames.length;

  // Progress bar
  const barWidth = 32;
  const filledWidth = Math.floor((progress / 100) * barWidth);
  const edgeChars = ['░', '▒', '▓', '█'];
  const edgeIndex = frame % edgeChars.length;
  const edgeChar = filledWidth < barWidth && filledWidth > 0 ? edgeChars[edgeIndex] : '';
  const progressBar =
    '█'.repeat(Math.max(0, filledWidth - 1)) +
    edgeChar +
    '░'.repeat(Math.max(0, barWidth - filledWidth - (edgeChar ? 1 : 0)));

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      setSkipped(true);
      setFadeOut(true);
      setTimeout(onComplete, 300);
    }
  });

  // Animation frame tick
  useEffect(() => {
    if (fadeOut || skipped) return;
    const timer = setInterval(() => setFrame(f => f + 1), 80);
    return () => clearInterval(timer);
  }, [fadeOut, skipped]);

  // Watch for all phases done
  useEffect(() => {
    if (doneCount === totalPhases && !fadeOut) {
      // All done — fade out after short delay
      const timer = setTimeout(() => {
        setFadeOut(true);
        setTimeout(onComplete, 500);
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [doneCount, totalPhases, fadeOut, onComplete]);

  const fadeOutProgress = fadeOut ? Math.max(0, 1 - (frame / 10)) : 1;
  const opacity = fadeOutProgress;
  const slideOffset = fadeOut ? Math.floor((1 - fadeOutProgress) * 3) : 0;

  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" height="100%">
      {/* Logo */}
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
        <Text bold color="cyan" dimColor={opacity < 0.7}>║                                       ║</Text>
        <Text bold color="cyan" dimColor={opacity < 0.7}>║   <Text dimColor color="gray">Away From Keyboard</Text>            ║</Text>
        <Text bold color="cyan" dimColor={opacity < 0.7}>║                                       ║</Text>
        <Text bold color="cyan" dimColor={opacity < 0.7}>╚═══════════════════════════════════════╝</Text>
      </Box>

      {/* Loading indicator */}
      <Box flexDirection="column" alignItems="center" marginBottom={2} marginTop={slideOffset}>
        <Box marginBottom={1}>
          <Text color="cyan" dimColor={opacity < 0.7}>{spinnerFrames[spinnerIndex]}</Text>
          <Text> </Text>
          <Text dimColor={opacity < 0.7}>{currentPhase?.icon}</Text>
          <Text> </Text>
          <Text dimColor={opacity < 0.7}>{currentPhase?.label}</Text>
          {currentPhase?.error && (
            <Text color="red"> error</Text>
          )}
        </Box>

        {/* Progress bar */}
        <Box flexDirection="column" alignItems="center">
          <Box marginBottom={0}>
            <Text color="cyan" dimColor={opacity < 0.7}>[</Text>
            <Text color="cyanBright" dimColor={opacity < 0.7}>{progressBar}</Text>
            <Text color="cyan" dimColor={opacity < 0.7}>]</Text>
          </Box>
          <Text dimColor color="gray">{progress}%</Text>
        </Box>

        {/* Phase list */}
        <Box flexDirection="column" marginTop={1} paddingLeft={4}>
          {visiblePhases.map((phase, i) => (
            <Text key={phase.key} dimColor={opacity < 0.7} color={phase.done ? 'green' : phase.error ? 'red' : undefined}>
              {phase.done
                ? (phase.error ? '✗' : '✓')
                : phase.icon} {phase.label}
              {phase.detail && (
                <Text dimColor> — {phase.detail}</Text>
              )}
              {phase.error && <Text color="red"> — {phase.error}</Text>}
            </Text>
          ))}
        </Box>
      </Box>

      {/* Skip hint */}
      <Box marginTop={1} marginBottom={slideOffset}>
        <Text dimColor color="gray">
          Press <Text color="yellow" bold={frame % 20 < 10}>ESC</Text> to skip
        </Text>
      </Box>
    </Box>
  );
};
