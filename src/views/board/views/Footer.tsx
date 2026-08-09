import React, { useState, useEffect } from 'react';
import { Box, Text, useStdout } from 'ink';
import { getShortPath, getGitBranch, formatPathLabel } from '../footer-helpers';
import { truncateByVisualWidth, visualWidth } from '../utils';
import type { View } from '../types';

interface Props {
  view?: View;
  detail?: boolean;
  search?: boolean;
  canOpen?: boolean;
  canAttach?: boolean;
}

/** Keep the asynchronous path label from consuming the footer's one-line shortcut row. */
export function fitFooterPath(pathInfo: string, columns: number, shortcuts: string): string {
  const available = columns - 2 - visualWidth(shortcuts) - 3;
  if (available < 12) return '';
  return truncateByVisualWidth(pathInfo, available);
}

export function Footer({ view = 'tasks', detail = false, search = false, canOpen = false, canAttach = false }: Props) {
  const [pathInfo, setPathInfo] = useState('');
  const { stdout } = useStdout();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const shortPath = getShortPath();
      const branch = await getGitBranch();
      if (!cancelled) {
        setPathInfo(formatPathLabel(shortPath, branch));
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  const openHint = canOpen ? ' · o open' : '';
  const attachHint = view === 'tasks' && detail && canAttach ? ' · a attach (interactive)' : '';
  const debugHint = ' · ctrl+d debug';
  const shortcuts = search
    ? `esc finish search${debugHint} · ? help`
    : detail
    ? `b/ESC back${openHint}${attachHint}${debugHint} · ? help`
    : view === 'board'
      ? `←→ lanes · ↑↓ cards · enter detail${openHint} · ${search ? 'esc finish search' : '/ search'}${debugHint} · ? help`
    : `↑↓ move · enter detail${openHint} · ${search ? 'esc finish search' : '/ search'}${debugHint} · ? help`;
  const columns = stdout.columns || process.stdout.columns || 80;
  const visiblePath = fitFooterPath(pathInfo, columns, shortcuts);

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
        <Text dimColor>{visiblePath}</Text>
        <Text color="white">{visiblePath ? ' │ ' : ''}</Text>
        <Text color={search ? 'cyan' : 'white'}>{shortcuts}</Text>
      </Text>
    </Box>
  );
}
