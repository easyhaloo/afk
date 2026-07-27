#!/usr/bin/env node
/**
 * Direct entry point for afk ui — renders Dashboard without Commander overhead.
 * Run via: node dist/commands/dashboard-entry.js
 */
import { render } from 'ink';
import React from 'react';
import { Dashboard } from '../views/dashboard/index.js';

export async function startDashboard() {
  if (!process.stdin.isTTY) {
    console.error('Error: afk ui requires an interactive terminal (TTY)');
    console.error('Current stdin is not a TTY. Please run this command in a real terminal.');
    process.exit(1);
  }

  process.stdout.write('\x1b[?1049h');

  const { waitUntilExit } = render(React.createElement(Dashboard), {
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
