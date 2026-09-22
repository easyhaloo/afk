#!/usr/bin/env node
import fs from 'node:fs';

function readInput() {
  const raw = fs.readFileSync(0, 'utf8').trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { command: raw }; }
}

function main() {
  const payload = readInput();
  const tool = payload.tool_name || payload.tool || 'Unknown';
  const command = payload.tool_input?.command || payload.command || payload.cmd || '';
  const decision = {
    decision: /(?:rm\s+-rf|git\s+reset\s+--hard|git\s+push\s+--force|curl\s+.*\|\s*(?:bash|sh)|wget\s+.*\|\s*(?:bash|sh))/i.test(command)
      ? 'deny'
      : /(?:secret|token|password|\.env|private[_-]?key)/i.test(command)
        ? 'deny'
        : 'allow',
    action: 'continue',
    dimension: 'permission',
    host: 'codex',
    tool,
    command,
    reason: 'codex adapter: local guard evaluation',
  };

  process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
}

main();
