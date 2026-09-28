#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compactToolOutput } from '../context-filter.mjs';
import { runAdapter } from './runtime-adapter.mjs';

export async function JevAgentGuard({ directory, env = process.env } = {}) {
  const recommendations = new Map();
  return {
    'chat.message': async (input, output) => {
      if (input.role && input.role !== 'user') return;
      const prompt = (output.parts ?? []).filter(part => part.type === 'text').map(part => part.text).join(' ').slice(0, 2000);
      const decision = await runAdapter({ host: 'opencode', event: 'prompt', payload: {
        prompt, session_id: input.sessionID, cwd: directory,
      }, env });
      if (decision.nextStep) recommendations.set(input.sessionID, decision.nextStep);
    },
    'experimental.chat.system.transform': async (input, output) => {
      const recommendation = recommendations.get(input.sessionID);
      if (!recommendation) return;
      output.system.push(recommendation);
      recommendations.delete(input.sessionID);
    },
    'tool.execute.before': async (input, output) => {
      const decision = await runAdapter({ host: 'opencode', event: 'before-action', payload: {
        tool_name: input.tool, session_id: input.sessionID, tool_input: output.args, cwd: directory,
      }, env });
      if (decision.decision === 'deny') throw new Error(decision.reason);
    },
    'tool.execute.after': async (input, output) => {
      const success = output.metadata?.exitCode === undefined || output.metadata.exitCode === 0;
      await runAdapter({ host: 'opencode', event: 'after-action', payload: {
        tool_name: input.tool, session_id: input.sessionID, tool_input: output.args, cwd: directory,
        outcome: { success },
      }, env });
      output.output = compactToolOutput({ command: output.args?.command ?? '', output: output.output,
        success: output.metadata?.exitCode === 0, fullRequested: env.JEV_FULL_OUTPUT === '1' });
    },
  };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let payload = {};
  try { payload = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { payload = {}; }
  const result = await runAdapter({ host: 'opencode', event: process.argv[2] ?? 'before-action', payload });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.decision === 'deny') process.exitCode = 2;
}
