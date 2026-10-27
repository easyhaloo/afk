import chalk from 'chalk';
import type { ErrorCode as RuntimeErrorCode } from '@afk/runtime/errors';

export { classifyError, type ErrorCode } from '@afk/runtime/errors';

export type JsonSuccess<T> = {
  ok: true;
  kind: string;
  data: T;
};

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface JsonFailureDetails {
  readonly hint?: string;
  readonly [key: string]: JsonValue | undefined;
}

export type JsonFailure = {
  ok: false;
  kind: string;
  error: {
    code: RuntimeErrorCode;
    message: string;
    details?: JsonFailureDetails;
  };
};

export type JsonEnvelope<T> = JsonSuccess<T> | JsonFailure;

/** Emit the canonical machine-readable success envelope to stdout. */
export function emitSuccess<T>(kind: string, data: T): void {
  const envelope: JsonSuccess<T> = { ok: true, kind, data };
  process.stdout.write(JSON.stringify(envelope));
}

/** Emit the canonical machine-readable failure envelope and set a failing exit code. */
export function emitFailure(
  kind: string,
  code: RuntimeErrorCode,
  message: string,
  details?: JsonFailureDetails,
): void {
  const envelope: JsonFailure = {
    ok: false,
    kind,
    error: details ? { code, message, details } : { code, message },
  };
  process.stdout.write(JSON.stringify(envelope));
  process.exitCode = 1;
}

/** Print pretty JSON for interactive command output. */
export function formatJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function getRecoveryHint(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes('GITLAB_TOKEN')) return 'Set GITLAB_TOKEN or authenticate: glab auth login';
  if (message.includes('GITHUB_TOKEN')) return 'Set GITHUB_TOKEN or authenticate: gh auth login';
  if (message.includes('GitLab project')) return 'Pass --project <repo-path>, or run from a git repo with a GitLab remote';
  if (message.includes('GITHUB_REPOSITORY')) return 'Set GITHUB_REPOSITORY=owner/repo or run from a GitHub repository';
  if (message.includes('not found') || message.includes('does not exist')) return 'Check the resource exists and you have access';
  if (message.includes('authentication') || message.includes('unauthorized')) return 'Verify your authentication token has the required permissions';

  return null;
}

/** Log and display a command failure with a recovery hint when one is known. */
export function handleCommandError(error: unknown, context?: string): never {
  const message = error instanceof Error ? error.message : String(error);
  const hint = getRecoveryHint(error);

  logger.error({ err: error, context }, 'command failed');
  console.error(chalk.red('Error:'), message);
  if (hint) console.error(chalk.yellow('Hint:'), hint);
  if (context) console.error(chalk.dim('Context:'), context);
  process.exit(1);
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
