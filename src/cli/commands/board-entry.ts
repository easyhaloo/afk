#!/usr/bin/env node
/**
 * Direct entry point for afk board — renders App without Commander overhead.
 * Run via: node dist/commands/board-entry.js
 */
import { render } from 'ink';
import React from 'react';
import { DashboardEntry } from '../../views/app/index.js';
import { handleCommandError } from '../cli-utils.js';

export async function startDashboard() {
  if (!process.stdin.isTTY) {
    handleCommandError(
      new Error('afk ui requires an interactive terminal (TTY)'),
      'Current stdin is not a TTY. Please run this command in a real terminal.',
    );
  }

  process.stdout.write('\x1b[?1049h');

  const { waitUntilExit } = render(React.createElement(DashboardEntry), {
    exitOnCtrlC: true,
    patchConsole: false,
  });

  await waitUntilExit();
  process.stdout.write('\x1b[?1049l');
  process.exit(0);
}

// Support direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  startDashboard();
}
