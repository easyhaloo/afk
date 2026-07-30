import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';
import { DashboardEntry } from '../views/app/index';

export function registerBoardCommands(program: Command) {
  program
    .command('board')
    .description('Interactive TUI board for monitoring tasks and sessions')
    .action(() => {
      // Enable alternate screen buffer
      process.stdout.write('\x1b[?1049h');

      const { waitUntilExit } = render(React.createElement(DashboardEntry), {
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
