import React from 'react';
import { Text } from 'ink';

interface Props {
  width: number;
  breathPhase: number;
  isTop?: boolean;
}

export function BreathingSeparator({ width, breathPhase, isTop = true }: Props) {
  const intensity = (Math.sin(breathPhase * Math.PI / 50) + 1) / 2;
  const gray = Math.round(128 - intensity * 100);

  const pattern = generateWavePattern(width);
  const start = isTop ? '.' : '`';
  const end = isTop ? '.' : "'";

  return (
    <Text color={`${gray}`}>
      {start}{pattern}{end}
    </Text>
  );
}

function generateWavePattern(w: number): string {
  let p = '';
  for (let i = 0; i < w - 2; i++) {
    const t = i % 10;
    if (t < 4) p += '~';
    else if (t < 6) { p += '~~'; i++; }
    else if (t < 8) { p += '~~~'; i += 2; }
    else p += '-';
  }
  return p.slice(0, w - 2);
}
