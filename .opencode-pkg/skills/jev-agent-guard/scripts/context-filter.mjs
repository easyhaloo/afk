export function compactToolOutput({ command, output, success, fullRequested = false }) {
  if (typeof output !== 'string' || output.length < 2048 || success !== true || fullRequested) return output;
  if (!/^(?:npm\s+(?:ci|install)|pnpm\s+install|yarn\s+install)(?:\s+[^;&|]*)?$/i.test(command.trim())) return output;
  if (/\b(?:error|warn(?:ing)?|fail(?:ed|ure)?|vulnerabilit(?:y|ies))\b/i.test(output)) return output;
  const lines = output.split(/\r?\n/);
  if (lines.length <= 40) return output;
  const removed = lines.length - 24;
  return `${lines.slice(0, 12).join('\n')}\n[Jev omitted ${removed} successful install-log lines; re-run the command for full output]\n${lines.slice(-12).join('\n')}`;
}
