#!/usr/bin/env node
/**
 * The TUI board — renders App without Commander overhead.
 *
 * `afk` with no arguments lands here. There is no `afk board` command:
 * the dispatcher refuses it and points at this path.
 */
import { render } from 'ink';
import React from 'react';
import { DashboardEntry } from '../../views/app/index.js';
import { handleCommandError } from '../cli-utils.js';
import { createCliRuntimePorts } from '../composition-root.js';

export async function startDashboard() {
  if (!process.stdin.isTTY) {
    handleCommandError(
      new Error('afk ui requires an interactive terminal (TTY)'),
      'Current stdin is not a TTY. Please run this command in a real terminal.',
    );
  }

  process.stdout.write('\x1b[?1049h');

  // The board reads the tracker, attaches a terminal and opens a link.
  // Each of those is the runtime's, and the board asks for it through a
  // port; which implementation answers is chosen here.
  const ports = await createCliRuntimePorts();
  const { waitUntilExit } = render(React.createElement(DashboardEntry, { ports }), {
    exitOnCtrlC: true,
    patchConsole: false,
    interactive: true,
  });

  await waitUntilExit();
  process.stdout.write('\x1b[?1049l');
  process.exit(0);
}

// Support direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  startDashboard();
}
