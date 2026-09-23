#!/usr/bin/env node
import { runAdapter } from './runtime-adapter.mjs';
export function createJevAgentGuardPlugin() {
  return {
    name: 'jev-agent-guard',
    async before(event) { return runAdapter({ host: 'opencode', event: 'before-action', payload: event }); },
    async after(event) { return runAdapter({ host: 'opencode', event: 'after-action', payload: event }); },
    async stop(event) { return runAdapter({ host: 'opencode', event: 'stop', payload: event }); }
  };
}
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
if (chunks.length) {
  let payload = {}; try { payload = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {}
  const result = await runAdapter({ host: 'opencode', event: process.argv[2] ?? 'before-action', payload });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = ['allow', 'keep', 'warn', 'finish'].includes(result.decision) ? 0 : 2;
}
