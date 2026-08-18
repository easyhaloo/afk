import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';
import { DashboardEntry } from '../../views/app/index';

export function registerBoardCommands(program: Command): void {
  program
    .command('board')
    .description('Interactive TUI board for monitoring backlog and task runtime')
    .action(() => {
      process.stdout.write('\x1b[?1049h');
      const { waitUntilExit } = render(React.createElement(DashboardEntry), {
        exitOnCtrlC: true,
        patchConsole: false,
      });
      waitUntilExit().then(() => {
        process.stdout.write('\x1b[?1049l');
        process.exit(0);
      });
    });
}
