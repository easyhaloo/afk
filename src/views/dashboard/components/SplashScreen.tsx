/**
 * SplashScreen - Animated loading screen with real loading phases
 *
 * Uses Ink's useAnimation hook (shared internal timer) instead of manual setInterval
 * for smooth,协调良好的动画循环。
 */
import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useAnimation } from 'ink';
import type { LoadingPhase } from '../hooks/useLoadingPhase';

interface SplashScreenProps {
  phases: LoadingPhase[];
  onComplete: () => void;
}

const LERP_FACTOR = 0.12; // how fast animProgress catches up (0-1, higher = faster)
const SNAP_THRESHOLD = 0.5; // snap to target when within this margin (eliminates end jitter)
const FADE_DURATION_MS = 800; // fade-out duration in milliseconds

const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const edgeChars = ['░', '▒', '▓', '█'];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Ease-out cubic: starts fast, ends slow — gives a natural deceleration
function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export const SplashScreen: React.FC<SplashScreenProps> = ({ phases, onComplete }) => {
  const [display, setDisplay] = useState({ progress: 0 });
  const [fadeOut, setFadeOut] = useState(false);
  const [skipped, setSkipped] = useState(false);

  // useAnimation: shared internal timer — no competition with React renders
  const { frame, time } = useAnimation({ interval: 16 }); // 60fps
  const animProgressRef = useRef(0);
  const realProgressRef = useRef(0);
  const fadeStartTimeRef = useRef<number | null>(null); // wall-clock ms when fadeOut began

  const totalPhases = phases.length;
  const doneCount = phases.filter(p => p.done).length;
  const realProgress = totalPhases > 0 ? Math.floor((doneCount / totalPhases) * 100) : 0;

  const visiblePhases = phases.filter(p => p.visible);
  const currentPhase = visiblePhases.find(p => !p.done) || visiblePhases[visiblePhases.length - 1];

  // Keep realProgress ref in sync with derived value
  useEffect(() => { realProgressRef.current = realProgress; }, [realProgress]);

  // Animation: lerp + snap toward realProgress, driven by useAnimation's frame
  useEffect(() => {
    const target = realProgressRef.current;
    const diff = Math.abs(target - animProgressRef.current);
    // Snap to target when close enough — eliminates end-of-loading jitter
    animProgressRef.current = diff < SNAP_THRESHOLD ? target
      : lerp(animProgressRef.current, target, LERP_FACTOR);
    // Only update React state during active loading (skip during fade for performance)
    if (!fadeOut) {
      setDisplay({ progress: animProgressRef.current });
    }
  }, [frame, fadeOut]);

  // Watch for all phases done
  useEffect(() => {
    if (doneCount === totalPhases && !fadeOut) {
      const timer = setTimeout(() => {
        fadeStartTimeRef.current = time;
        setFadeOut(true);
        setTimeout(onComplete, FADE_DURATION_MS);
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [doneCount, totalPhases, fadeOut, onComplete, time]);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      setSkipped(true);
      fadeStartTimeRef.current = time;
      setFadeOut(true);
      setTimeout(onComplete, 300);
    }
  });

  // Fade-out progress using wall-clock time (more reliable than frame counting)
  const fadeT = (() => {
    if (!fadeOut || fadeStartTimeRef.current === null) return 1;
    const elapsed = time - fadeStartTimeRef.current;
    return Math.min(1, elapsed / FADE_DURATION_MS);
  })();
  const fadeOutProgress = easeOut(fadeT);
  const opacity = fadeOut ? fadeOutProgress : 1;
  const slideOffset = fadeOut ? Math.floor((1 - fadeOutProgress) * 3) : 0;

  const spinnerIndex = frame % spinnerFrames.length;
  const barWidth = 32;
  const filledWidth = Math.floor((display.progress / 100) * barWidth);
  const edgeIndex = frame % edgeChars.length;
  const edgeChar = filledWidth < barWidth && filledWidth > 0 ? edgeChars[edgeIndex] : '';
  const progressBar =
    '█'.repeat(Math.max(0, filledWidth - 1)) +
    edgeChar +
    '░'.repeat(Math.max(0, barWidth - filledWidth - (edgeChar ? 1 : 0)));

  const displayedPct = Math.round(display.progress);

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
