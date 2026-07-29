/**
 * SplashScreen - Animated loading screen with real loading phases
 *
 * Animation strategy:
 * - animProgressRef: updated at 60fps (16ms), smoothly lerps toward real progress
 * - frameRef: always ticking for spinner + edge animation
 * - React state: throttled to 50ms to batch re-renders
 */
import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import type { LoadingPhase } from '../hooks/useLoadingPhase';

interface SplashScreenProps {
  phases: LoadingPhase[];
  onComplete: () => void;
}

const TICK_MS = 16;       // 60fps animation tick
const LERP_FACTOR = 0.12; // how fast animProgress catches up (0-1, higher = faster)

const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const edgeChars = ['░', '▒', '▓', '█'];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export const SplashScreen: React.FC<SplashScreenProps> = ({ phases, onComplete }) => {
  const [display, setDisplay] = useState({ progress: 0, frame: 0 });
  const [fadeOut, setFadeOut] = useState(false);
  const [skipped, setSkipped] = useState(false);

  const animProgressRef = useRef(0);
  const realProgressRef = useRef(0);
  const frameRef = useRef(0);

  const totalPhases = phases.length;
  const doneCount = phases.filter(p => p.done).length;
  const realProgress = totalPhases > 0 ? Math.floor((doneCount / totalPhases) * 100) : 0;

  const visiblePhases = phases.filter(p => p.visible);
  const currentPhase = visiblePhases.find(p => !p.done) || visiblePhases[visiblePhases.length - 1];

  // Keep realProgress ref in sync with derived value
  useEffect(() => { realProgressRef.current = realProgress; }, [realProgress]);

  // High-freq animation loop
  useEffect(() => {
    let animFrame: ReturnType<typeof setInterval>;

    const loop = () => {
      animProgressRef.current = lerp(animProgressRef.current, realProgressRef.current, LERP_FACTOR);
      frameRef.current += 1;
      // Skip React update during fadeOut — display values are frozen anyway
      if (!fadeOut) {
        setDisplay({ progress: animProgressRef.current, frame: frameRef.current });
      }
    };

    animFrame = setInterval(loop, TICK_MS);
    return () => clearInterval(animFrame);
  }, [fadeOut]);

  // Watch for all phases done
  useEffect(() => {
    if (doneCount === totalPhases && !fadeOut) {
      const timer = setTimeout(() => {
        setFadeOut(true);
        setTimeout(onComplete, 500);
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [doneCount, totalPhases, fadeOut, onComplete]);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      setSkipped(true);
      setFadeOut(true);
      setTimeout(onComplete, 300);
    }
  });

  const { progress, frame } = display;
  const fadeOutProgress = fadeOut ? Math.max(0, 1 - (frame / 31)) : 1; // ~500ms at 60fps
  const opacity = fadeOut ? fadeOutProgress : 1;
  const slideOffset = fadeOut ? Math.floor((1 - fadeOutProgress) * 3) : 0;

  const spinnerIndex = frame % spinnerFrames.length;
  const barWidth = 32;
  const filledWidth = Math.floor((progress / 100) * barWidth);
  const edgeIndex = frame % edgeChars.length;
  const edgeChar = filledWidth < barWidth && filledWidth > 0 ? edgeChars[edgeIndex] : '';
  const progressBar =
    '█'.repeat(Math.max(0, filledWidth - 1)) +
    edgeChar +
    '░'.repeat(Math.max(0, barWidth - filledWidth - (edgeChar ? 1 : 0)));

  const displayedPct = Math.round(progress);

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
          <Text dimColor color="gray">{displayedPct}%</Text>
        </Box>

        {/* Phase list */}
        <Box flexDirection="column" marginTop={1} paddingLeft={4}>
          {visiblePhases.map((phase) => (
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
