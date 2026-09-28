#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runAdapter } from './runtime-adapter.mjs';

export function toCodexResponse(result, event) {
  if (event === 'resume-context' && result.nextStep) {
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: result.nextStep } };
  }
  if (event === 'prompt' && result.nextStep) {
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: result.nextStep } };
  }
  if (event === 'before-action') {
    if (result.decision === 'needs-user') {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: result.reason } };
    }
    if (result.decision !== 'deny') return {};
    return { hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: result.reason,
    } };
  }
  if (event === 'stop' && result.decision === 'deny') return { decision: 'block', reason: result.reason };
  if (event === 'after-action' && result.nextStep) {
    return { hookSpecificOutput: { hookEventName: 'PostToolUse',
      additionalContext: `${result.reason} Next: ${result.nextStep}` } };
  }
  return { continue: true, systemMessage: result.decision === 'advise' ? result.reason : undefined };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let payload = {};
  try { payload = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { payload = {}; }
  const event = process.argv[2] ?? 'before-action';
  const result = await runAdapter({ host: 'codex', event, payload });
  process.stdout.write(`${JSON.stringify(toCodexResponse(result, event))}\n`);
}
