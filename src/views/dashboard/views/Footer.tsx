import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import simpleGit from 'simple-git';

function getShortPath(): string {
  const cwd = process.cwd();
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home && cwd.startsWith(home)) {
    return '~' + cwd.slice(home.length);
  }
  return cwd;
}

async function getGitBranch(): Promise<string | null> {
  try {
    const git = simpleGit();
    const result = await git.branchLocal();
    return result.current || null;
  } catch {
    return null;
  }
}

export function Footer() {
  const [pathInfo, setPathInfo] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const shortPath = getShortPath();
      const branch = await getGitBranch();
      if (!cancelled) {
        setPathInfo(branch ? `${shortPath} (${branch})` : shortPath);
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

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
        <Text dimColor>{pathInfo}</Text>
        <Text color="white"> │ </Text>
        <Text color="gray">b</Text>
        <Text color="white"> back │ </Text>
        <Text color="gray">?</Text>
        <Text color="white"> help │ </Text>
        <Text color="gray">↑↓</Text>
        <Text color="white"> │ </Text>
        <Text color="gray">o</Text>
        <Text color="white"> open │ </Text>
        <Text color="gray">r</Text>
        <Text color="white"> │ </Text>
      </Text>
    </Box>
  );
}
