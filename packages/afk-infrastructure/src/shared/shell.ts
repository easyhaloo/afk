/**
 * Quoting for a shell command.
 *
 * The command is assembled as text and handed to a shell, so each argument
 * is quoted on its own: a value with a space in it stays one argument, and
 * a quote inside it does not end the quoting early.  Three callers were
 * doing this by hand — the local sandbox, and the desktop's terminal
 * adapter and foreground agent command — and each of them had to get the
 * embedded-quote form right on its own.
 */
export function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
