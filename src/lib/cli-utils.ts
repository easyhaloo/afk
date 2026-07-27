import chalk from 'chalk';

/**
 * Parse comma-separated string into trimmed array
 */
export function parseCommaSeparated(input: string): string[] {
  return input.split(',').map(item => item.trim()).filter(Boolean);
}

/**
 * Format JSON output consistently
 */
export function formatJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Get recovery hint for common errors
 */
function getRecoveryHint(error: unknown): string | null {
  const message = (error as Error).message;

  if (message.includes('GITLAB_TOKEN')) {
    return 'Set GITLAB_TOKEN or authenticate: glab auth login';
  }
  if (message.includes('GITHUB_TOKEN')) {
    return 'Set GITHUB_TOKEN or authenticate: gh auth login';
  }
  if (message.includes('GITLAB_PROJECT_ID')) {
    return 'Set GITLAB_PROJECT_ID or run from a GitLab repository';
  }
  if (message.includes('GITHUB_REPOSITORY')) {
    return 'Set GITHUB_REPOSITORY=owner/repo or run from a GitHub repository';
  }
  if (message.includes('not found') || message.includes('does not exist')) {
    return 'Check the resource exists and you have access';
  }
  if (message.includes('authentication') || message.includes('unauthorized')) {
    return 'Verify your authentication token has the required permissions';
  }

  return null;
}

/**
 * Handle command error with user-friendly formatting and exit
 *
 * @param error - The error to handle
 * @param context - Optional context about what was being attempted
 */
export function handleCommandError(error: unknown, context?: string): never {
  const message = (error as Error).message;
  const hint = getRecoveryHint(error);

  console.error(chalk.red('Error:'), message);

  if (hint) {
    console.error(chalk.yellow('Hint:'), hint);
  }

  if (context) {
    console.error(chalk.dim('Context:'), context);
  }

  process.exit(1);
}

/**
 * Log error and return fallback value (for non-critical operations)
 *
 * @param error - The error to log
 * @param context - Context about what failed
 * @param fallback - Fallback value to return
 */
export function logAndReturn<T>(error: unknown, context: string, fallback: T): T {
  const message = error instanceof Error ? error.message : String(error);
  console.error(chalk.yellow('Warning:'), `${context}:`, message);
  return fallback;
}

/**
 * Display success message with checkmark
 */
export function success(message: string): void {
  console.log(chalk.green('✓'), message);
}

/**
 * Display info message
 */
export function info(message: string): void {
  console.log(chalk.blue('ℹ'), message);
}

/**
 * Display warning message
 */
export function warning(message: string): void {
  console.log(chalk.yellow('⚠'), message);
}
