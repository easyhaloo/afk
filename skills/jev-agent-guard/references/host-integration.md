#!/usr/bin/env node
import { askJev, choice, noul, score } from '../jev-client.mjs';

function normalizePayload(raw) {
  if (!raw || typeof raw !== 'object') return { tool: 'unknown', command: '', path: '' };
  return {
    tool: raw.tool || raw.tool_name || raw.name || 'unknown',
    command: raw.command || raw.raw_command || '',
    path: raw.path || raw.file_path || raw.target || '',
  };
}

async function main() {
  const payload = normalizePayload(globalThis.__OPENCODE__ || {});
  const state = { tool: payload.tool, command: payload.command, path: payload.path };
  const result = await askJev({
    state,
    questions: {
      risk: noul('Is this action risky enough to require approval?'),
      intent: choice('Which action is this?', {
        read: 'Local read-only inspection.',
        edit: 'Local workspace edit.',
        command: 'Shell command or external behavior.',
        dangerous: 'Destructive or credential-related action.',
      }),
      severity: score('How risky is this action?', ['safe', 'review', 'dangerous']),
    },
  });

  const decision = {
    decision: result.answers.risk.noul >= 0.7 || result.answers.intent.choice === 'dangerous' ? 'deny' : 'allow',
    action: result.answers.risk.noul >= 0.7 || result.answers.intent.choice === 'dangerous' ? 'block' : 'continue',
    dimension: 'opencode-policy',
    reason: 'OpenCode adapter delegates to the shared Jev guard policy.',
    host: 'opencode',
    tool: payload.tool,
    command: payload.command,
  };

  process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
  process.exitCode = decision.decision === 'allow' ? 0 : 2;
}

main().catch(error => {
  process.stderr.write(`${error.code ?? 'jev_error'}: ${error.message}\n`);
  process.exit(3);
});
