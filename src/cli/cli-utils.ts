import chalk from 'chalk';
import { logger } from '../infrastructure/io/index';
export { openInBrowser } from '../shared/browser';

/** Parse comma-separated string into trimmed array. */
export function parseCommaSeparated(input: string): string[] {
  return input.split(',').map(item => item.trim()).filter(Boolean);
}

/** Format JSON output consistently. */
export function formatJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/** Get recovery hint for common errors. */
function getRecoveryHint(error: unknown): string | null {
  const message = (error as Error).message;

  if (message.includes('GITLAB_TOKEN')) return 'Set GITLAB_TOKEN or authenticate: glab auth login';
  if (message.includes('GITHUB_TOKEN')) return 'Set GITHUB_TOKEN or authenticate: gh auth login';
  if (message.includes('GitLab project')) return 'Pass --project <repo-path>, or run from a git repo with a GitLab remote';
  if (message.includes('GITHUB_REPOSITORY')) return 'Set GITHUB_REPOSITORY=owner/repo or run from a GitHub repository';
  if (message.includes('not found') || message.includes('does not exist')) return 'Check the resource exists and you have access';
  if (message.includes('authentication') || message.includes('unauthorized')) return 'Verify your authentication token has the required permissions';

  return null;
}

/** Handle command error with user-friendly formatting and exit. */
export function handleCommandError(error: unknown, context?: string): never {
  const message = (error as Error).message;
  const hint = getRecoveryHint(error);

  logger.error({ err: error, context }, 'command failed');
  console.error(chalk.red('Error:'), message);
  if (hint) console.error(chalk.yellow('Hint:'), hint);
  if (context) console.error(chalk.dim('Context:'), context);
  process.exit(1);
}

/** Log error and return fallback value (for non-critical operations). */
export function logAndReturn<T>(error: unknown, context: string, fallback: T): T {
  logger.warn({ context, err: error }, 'non-critical operation failed');
  return fallback;
}

export function success(message: string): void {
  console.log(chalk.green('✓'), message);
}

export function info(message: string): void {
  console.log(chalk.blue('ℹ'), message);
}

export function warning(message: string): void {
  console.log(chalk.yellow('⚠'), message);
}

export function fail(message: string): void {
  console.error(chalk.red('✗'), message);
}

export function detail(message: string): void {
  console.log(chalk.dim('  ' + message));
}
