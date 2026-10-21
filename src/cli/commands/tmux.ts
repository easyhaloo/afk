import { Command } from 'commander';
import chalk from 'chalk';
import type { CommandRegistrationContext } from '../command-registry.js';
import { handleCommandError, success, info, warning, detail, formatJson } from '../cli-utils.js';

/**
 * The tmux sessions, driven from the command line.
 *
 * The command says what the user asked for - make a session, send a goal,
 * read the pane - and the runtime says how a session is made. The command
 * never holds a tmux client, so it can be exercised without one.
 */
export function registerTmuxCommands(program: Command, context: CommandRegistrationContext): void {
  const tmux = context.ports.tmux;
  const tmuxCommand = program
    .command('tmux')
    .description('Tmux session management for Claude agent');

  /**
   * create-session command
   */
  tmuxCommand
    .command('create-session')
    .description('Create new tmux session for Claude')
    .requiredOption('-n, --name <name>', 'Session name')
    .requiredOption('-d, --dir <path>', 'Working directory')
    .option('-c, --command <cmd>', 'Command to run', 'claude')
    .action(async (options) => {
      try {
        const session = await tmux.createSession(options.name, options.dir, options.command);

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
  tmuxCommand
    .command('send-goal')
    .description('Send /goal command to Claude session')
    .requiredOption('-s, --session <name>', 'Session name')
    .option('-w, --window <name>', 'Window name', 'main')
    .requiredOption('-t, --text <text>', 'Goal text')
    .requiredOption('-d, --worktree <path>', 'Worktree path (used for prompt-ready detection)')
    .action(async (options) => {
      try {
        info(`Sending /goal to ${options.session}:${options.window}...`);
        await tmux.sendPrompt(options.worktree, options.session, options.window, options.text, 'goal_complete', tmux.readiness('claude-code'));

        success('Goal sent successfully');
      } catch (error) {
        handleCommandError(error);
      }
    });

  /**
   * capture command
   */
  tmuxCommand
    .command('capture')
    .description('Capture pane content')
    .requiredOption('-s, --session <name>', 'Session name')
    .option('-w, --window <name>', 'Window name', 'main')
    .option('-l, --lines <n>', 'Number of lines to capture', '50')
    .option('--history <n>', 'History size to read from', '100')
    .action(async (options) => {
      try {
        const content = await tmux.capturePane(
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
  tmuxCommand
    .command('wait-signal')
    .description('Wait for signal file or pane marker')
    .requiredOption('-s, --session <name>', 'Session name')
    .option('-w, --window <name>', 'Window name', 'main')
    .requiredOption('-t, --type <type>', 'Signal type (goal_complete, handoff_ready)')
    .requiredOption('-d, --dir <path>', 'Worktree directory')
    .option('--timeout <ms>', 'Timeout in milliseconds', '300000')
    .action(async (options) => {
      try {
        info(`Waiting for ${options.type} signal...`);
        const signal = await tmux.waitForSignal(
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
  tmuxCommand
    .command('kill-session')
    .description('Kill tmux session')
    .argument('<name>', 'Session name')
    .action(async (name: string) => {
      try {
        await tmux.killSession(name);

        success(`Session ${name} killed`);
      } catch (error) {
        handleCommandError(error);
      }
    });

  /**
   * has-session command
   */
  tmuxCommand
    .command('has-session')
    .description('Check if session exists')
    .argument('<name>', 'Session name')
    .action(async (name: string) => {
      try {
        const exists = await tmux.hasSession(name);

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
