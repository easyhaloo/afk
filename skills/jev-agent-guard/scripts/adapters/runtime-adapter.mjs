#!/usr/bin/env node
import fs from 'node:fs/promises';
import { evaluateSemantic } from '../semantic-engine.mjs';

function parse(raw) { try { return raw?.trim() ? JSON.parse(raw) : {}; } catch { return {}; } }
function compact(value, max = 4000) {
  const text = JSON.stringify(value ?? {});
  return text.length <= max ? value : { summary: text.slice(0, max), truncated: true };
}
async function input() { const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); return parse(Buffer.concat(chunks).toString()); }
function normalize(payload, host, eventKind) {
  const action = payload.action ?? {};
  return {
    event_kind: eventKind,
    session_id: payload.session_id ?? payload.sessionId,
    goal: payload.goal ?? payload.task?.goal ?? '',
    requirements: payload.requirements ?? payload.task?.requirements ?? [],
    action: {
      kind: action.kind ?? payload.action_kind ?? 'unknown',
      tool: action.tool ?? payload.tool_name ?? payload.tool ?? 'unknown',
      command: action.command ?? payload.command ?? payload.cmd ?? '',
      path: action.path ?? payload.file_path ?? payload.path ?? null,
      network: Boolean(action.network ?? payload.network),
      credential_access: Boolean(action.credential_access ?? payload.credential_access)
    },
    trajectory: payload.trajectory ?? {},
    context: payload.context ?? {},
    validation: payload.validation ?? {},
    host,
    raw_summary: compact(payload)
  };
}
function ruleFor(event) {
  if (event === 'before-action') return 'action-risk';
  if (event === 'after-action') return 'trajectory-state';
  if (event === 'context-review') return 'context-retention';
  if (event === 'stop') return 'skill-compliance';
  throw new Error(`Unsupported event: ${event}`);
}
export async function runAdapter({ host, event = 'before-action', payload }) {
  const state = normalize(payload, host, event);
  try {
    const result = await evaluateSemantic(ruleFor(event), state);
    return { schema_version: 1, host, event, ...result, state: undefined };
  } catch (error) {
    const failClosed = event === 'before-action' || event === 'stop';
    return { schema_version: 1, host, event, decision: failClosed ? 'confirm' : 'warn', action: failClosed ? 'request_user_approval' : 'continue', reason: `Jev evaluation unavailable: ${error.message}`, error_code: error.code ?? 'jev_error' };
  }
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const event = process.argv[2] ?? 'before-action';
  const payload = await input();
  const result = await runAdapter({ host: 'claude-code', event, payload });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = ['allow', 'keep', 'warn', 'finish'].includes(result.decision) ? 0 : 2;
}
