/**
 * SplashScreen - Animated loading screen with real loading phases
 *
 * Uses Ink's useAnimation (shared internal timer).
 * Progress is time-based: each phase has a budget,进度条匀速推进到100%。
 * No lerp/Snap chasing needed — progress is a pure function of time.
 */
import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useAnimation } from 'ink';
import type { LoadingPhase } from '../hooks/useLoadingPhase';

interface SplashScreenProps {
  phases: LoadingPhase[];
  onComplete: () => void;
}

const FADE_DURATION_MS = 800;

// Each phase's time budget in ms (config, detect, connect, tasks, sessions, ready)
const PHASE_BUDGETS = [400, 300, 800, 600, 500, 400];
const TOTAL_BUDGET = PHASE_BUDGETS.reduce((a, b) => a + b, 0); // = 3000ms

const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const edgeChars = ['░', '▒', '▓', '█'];

function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Maps wall-clock time to a 0-100 progress value.
 * Progress is continuous and linear based on phase time budgets,
 * regardless of how long each phase's fetch actually takes.
 */
function getProgressFromTime(time: number, doneCount: number): number {
  if (doneCount >= PHASE_BUDGETS.length) return 100;
  if (time >= TOTAL_BUDGET) return 100;

  let elapsed = 0;
  for (let i = 0; i < PHASE_BUDGETS.length; i++) {
    const budget = PHASE_BUDGETS[i];
    if (time < elapsed + budget) {
      // Inside phase i: interpolate within the phase
      const phaseT = (time - elapsed) / budget;
      const prevPhasesMs = PHASE_BUDGETS.slice(0, i).reduce((a, b) => a + b, 0);
      const prevPct = (prevPhasesMs / TOTAL_BUDGET) * 100;
      const thisPct = (budget / TOTAL_BUDGET) * 100;
      return prevPct + phaseT * thisPct;
    }
    elapsed += budget;
  }
  // Exactly at a phase boundary: return the accumulated percentage of completed phases
  const doneMs = PHASE_BUDGETS.slice(0, doneCount).reduce((a, b) => a + b, 0);
  return (doneMs / TOTAL_BUDGET) * 100;
}

export const SplashScreen: React.FC<SplashScreenProps> = ({ phases, onComplete }) => {
  const [fadeOut, setFadeOut] = useState(false);
  const [skipped, setSkipped] = useState(false);

  const { frame, time } = useAnimation({ interval: 16 }); // 60fps
  const fadeStartTimeRef = useRef<number>(-1); // -1 = not started

  const doneCount = phases.filter(p => p.done).length;
  const progress = getProgressFromTime(time, doneCount);
  const visiblePhases = phases.filter(p => p.visible);
  const currentPhase = visiblePhases.find(p => !p.done) || visiblePhases[visiblePhases.length - 1];

  // Watch for all phases done
  useEffect(() => {
    if (doneCount === phases.length && !fadeOut) {
      const timer = setTimeout(() => {
        fadeStartTimeRef.current = time;
        setFadeOut(true);
        setTimeout(onComplete, FADE_DURATION_MS);
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [doneCount, phases.length, fadeOut, onComplete, time]);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      setSkipped(true);
      fadeStartTimeRef.current = time;
      setFadeOut(true);
      setTimeout(onComplete, 300);
    }
  });

  // Fade-out using wall-clock time
  const fadeT = fadeOut && fadeStartTimeRef.current >= 0
    ? Math.min(1, (time - fadeStartTimeRef.current) / FADE_DURATION_MS)
    : 1;
  const fadeOutProgress = easeOut(fadeT);
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
