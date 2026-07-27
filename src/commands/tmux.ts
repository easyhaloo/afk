import { Command } from 'commander';
import chalk from 'chalk';
import { TmuxClient } from '../lib/tmux';
import { handleCommandError } from '../lib/cli-utils';

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

        console.log(chalk.green('✓ Tmux session created'));
        console.log(chalk.gray(`  Name: ${session.name}`));
        console.log(chalk.gray(`  Window: ${session.window}`));
        console.log(chalk.gray(`  Dir: ${session.dir}`));
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
    .action(async (options) => {
      try {
        const client = new TmuxClient();

        console.log(chalk.blue(`Sending /goal to ${options.session}:${options.window}...`));
        await client.sendGoal(options.session, options.window, options.text);

        console.log(chalk.green('✓ Goal sent successfully'));
      } catch (error) {
        handleCommandError(error);
      }
    });

  /**
   * wait-for-prompt command
   */
  tmux
    .command('wait-for-prompt')
    .description('Wait for Claude prompt (❯) to appear')
    .requiredOption('-s, --session <name>', 'Session name')
    .option('-w, --window <name>', 'Window name', 'main')
    .option('--timeout <ms>', 'Timeout in milliseconds', '30000')
    .action(async (options) => {
      try {
        const client = new TmuxClient();

        console.log(chalk.blue(`Waiting for prompt in ${options.session}:${options.window}...`));
        const success = await client.waitForPrompt(
          options.session,
          options.window,
          parseInt(options.timeout)
        );

        if (success) {
          console.log(chalk.green('✓ Prompt detected'));
        } else {
          console.log(chalk.yellow('⚠ Timeout waiting for prompt'));
          process.exit(1);
        }
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
    .requiredOption('-t, --type <type>', 'Signal type (goal_complete, ac_result, handoff_ready)')
    .requiredOption('-d, --dir <path>', 'Worktree directory')
    .option('--timeout <ms>', 'Timeout in milliseconds', '300000')
    .action(async (options) => {
      try {
        const client = new TmuxClient();

        console.log(chalk.blue(`Waiting for ${options.type} signal...`));
        const signal = await client.waitForSignal(
          options.session,
          options.window,
          options.type,
          options.dir,
          parseInt(options.timeout)
        );

        if (signal) {
          console.log(chalk.green(`✓ Signal received: ${signal.type}`));
          console.log(JSON.stringify(signal, null, 2));
        } else {
          console.log(chalk.yellow('⚠ Timeout waiting for signal'));
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

        console.log(chalk.green(`✓ Session ${name} killed`));
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
          console.log(chalk.green(`✓ Session ${name} exists`));
          process.exit(0);
        } else {
          console.log(chalk.yellow(`Session ${name} not found`));
          process.exit(1);
        }
      } catch (error) {
        handleCommandError(error);
      }
    });
}
