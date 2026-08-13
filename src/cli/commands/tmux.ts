import { Command } from 'commander';
import chalk from 'chalk';
import { TmuxClient } from '../../infrastructure/tmux/tmux';
import { handleCommandError, success, info, warning, detail, formatJson } from '../lib/cli-utils';

export function registerTmuxCommands(program: Command): void {
  const tmux = program
    .command('tmux')
    .description('Tmux session management for Claude agent');

  /**
   * create-session command
   */
  tmux
    .command('create-session')
    .description('Create new tmux session for Claude')
    .requiredOption('-n, --name <name>', 'Session name')
    .requiredOption('-d, --dir <path>', 'Working directory')
    .option('-c, --command <cmd>', 'Command to run', 'claude')
    .action(async (options) => {
      try {
        const client = new TmuxClient();
        const session = await client.createSession(options.name, options.dir, options.command);

        success('Tmux session created');
        detail(`Name: ${session.name}`);
        detail(`Window: ${session.window}`);
        detail(`Dir: ${session.dir}`);
        console.log();
        console.log(chalk.dim(`Attach with: tmux attach -t ${session.name}`));
      } catch (error) {
        handleCommandError(error);
      }
    });

  /**
   * send-goal command
   */
  tmux
    .command('send-goal')
    .description('Send /goal command to Claude session')
    .requiredOption('-s, --session <name>', 'Session name')
    .option('-w, --window <name>', 'Window name', 'main')
    .requiredOption('-t, --text <text>', 'Goal text')
    .requiredOption('-d, --worktree <path>', 'Worktree path (used for prompt-ready detection)')
    .action(async (options) => {
      try {
        const client = new TmuxClient();

        info(`Sending /goal to ${options.session}:${options.window}...`);
        await client.sendPrompt(options.worktree, options.session, options.window, options.text);

        success('Goal sent successfully');
      } catch (error) {
        handleCommandError(error);
      }
    });

  /**
   * capture command
   */
  tmux
    .command('capture')
    .description('Capture pane content')
    .requiredOption('-s, --session <name>', 'Session name')
    .option('-w, --window <name>', 'Window name', 'main')
    .option('-l, --lines <n>', 'Number of lines to capture', '50')
    .option('--history <n>', 'History size to read from', '100')
    .action(async (options) => {
      try {
        const client = new TmuxClient();
        const content = await client.capturePane(
          options.session,
          options.window,
          {
            lines: parseInt(options.lines),
            history: parseInt(options.history),
          }
        );

        console.log(content);
      } catch (error) {
        handleCommandError(error);
      }
    });

  /**
   * wait-signal command
   */
  tmux
    .command('wait-signal')
    .description('Wait for signal file or pane marker')
    .requiredOption('-s, --session <name>', 'Session name')
    .option('-w, --window <name>', 'Window name', 'main')
    .requiredOption('-t, --type <type>', 'Signal type (goal_complete, handoff_ready)')
    .requiredOption('-d, --dir <path>', 'Worktree directory')
    .option('--timeout <ms>', 'Timeout in milliseconds', '300000')
    .action(async (options) => {
      try {
        const client = new TmuxClient();

        info(`Waiting for ${options.type} signal...`);
        const signal = await client.waitForSignal(
          options.session,
          options.window,
          options.type,
          options.dir,
          parseInt(options.timeout)
        );

        if (signal) {
          success(`Signal received: ${signal.type}`);
          formatJson(signal);
        } else {
          warning('Timeout waiting for signal');
          process.exit(1);
        }
      } catch (error) {
        handleCommandError(error);
      }
    });

  /**
   * kill-session command
   */
  tmux
    .command('kill-session')
    .description('Kill tmux session')
    .argument('<name>', 'Session name')
    .action(async (name: string) => {
      try {
        const client = new TmuxClient();
        await client.killSession(name);

        success(`Session ${name} killed`);
      } catch (error) {
        handleCommandError(error);
      }
    });

  /**
   * has-session command
   */
  tmux
    .command('has-session')
    .description('Check if session exists')
    .argument('<name>', 'Session name')
    .action(async (name: string) => {
      try {
        const client = new TmuxClient();
        const exists = await client.hasSession(name);

        if (exists) {
          success(`Session ${name} exists`);
          process.exit(0);
        } else {
          warning(`Session ${name} not found`);
          process.exit(1);
        }
      } catch (error) {
        handleCommandError(error);
      }
    });
}
