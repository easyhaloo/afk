#!/usr/bin/env node
/**
 * Direct entry point for afk ui — renders Dashboard without Commander overhead.
 * Run via: node dist/commands/dashboard-entry.js
 */
import { render } from 'ink';
import React from 'react';
import { Dashboard } from '../views/dashboard/index.js';

process.stdout.write('\x1b[?1049h');

const { waitUntilExit } = render(React.createElement(Dashboard), {
  exitOnCtrlC: true,
  patchConsole: false,
});

waitUntilExit().then(() => {
  process.stdout.write('\x1b[?1049l');
  process.exit(0);
});
