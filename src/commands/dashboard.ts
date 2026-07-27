import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';
import { Dashboard } from '../views/dashboard/index.js';

export function registerDashboardCommands(program: Command) {
  program
    .command('dashboard')
    .alias('ui')
    .description('Interactive TUI dashboard for monitoring tasks and sessions')
    .action(() => {
      // Enable alternate screen buffer
      process.stdout.write('\x1b[?1049h');

      const { waitUntilExit } = render(React.createElement(Dashboard), {
        exitOnCtrlC: true,
        patchConsole: false,
      });

      waitUntilExit().then(() => {
        // Disable alternate screen buffer
        process.stdout.write('\x1b[?1049l');
        process.exit(0);
      });
    });
}
