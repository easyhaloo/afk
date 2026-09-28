#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compactToolOutput } from '../context-filter.mjs';
import { runAdapter } from './runtime-adapter.mjs';

export function toClaudeResponse(result, event, payload = {}) {
  if (event === 'resume-context' && result.nextStep) {
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: result.nextStep } };
  }
  if (event === 'prompt' && result.nextStep) {
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: result.nextStep } };
  }
  if (event === 'before-action') {
    if (result.decision !== 'needs-user' && result.decision !== 'deny') return {};
    const permissionDecision = result.decision === 'needs-user' ? 'ask' : 'deny';
    return { hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: result.reason,
    } };
  }
  if (event === 'after-failure' && result.nextStep) {
    return { hookSpecificOutput: { hookEventName: 'PostToolUseFailure',
      additionalContext: `${result.reason} Next: ${result.nextStep}` } };
  }
  const toolOutput = typeof payload.tool_response === 'string' ? payload.tool_response : payload.tool_response?.stdout;
  if (event === 'after-action' && typeof toolOutput === 'string') {
    const filtered = compactToolOutput({ command: payload.tool_input?.command ?? '', output: toolOutput,
      success: result.decision === 'allow' && !payload.tool_response_is_error,
      fullRequested: payload.full_output_requested === true });
    if (filtered !== toolOutput) {
      const updatedToolOutput = typeof payload.tool_response === 'string'
        ? filtered : { ...payload.tool_response, stdout: filtered };
      return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput } };
    }
  }
  if (event === 'stop' && result.decision === 'deny') return { decision: 'block', reason: result.reason };
  return { continue: true, systemMessage: result.decision === 'advise' ? result.reason : undefined };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let payload = {};
  try { payload = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { payload = {}; }
  const event = process.argv[2] ?? 'before-action';
  const result = await runAdapter({ host: 'claude-code', event: event === 'after-failure' ? 'after-action' : event,
    payload: event === 'after-failure' ? { ...payload, outcome: { success: false } } : payload });
  process.stdout.write(`${JSON.stringify(toClaudeResponse(result, event, payload))}\n`);
}
