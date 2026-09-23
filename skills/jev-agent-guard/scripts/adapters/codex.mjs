#!/usr/bin/env node
import { runAdapter } from './runtime-adapter.mjs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let payload = {}; try { payload = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {}
const result = await runAdapter({ host: 'codex', event: process.argv[2] ?? 'before-action', payload });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = ['allow', 'keep', 'warn', 'finish'].includes(result.decision) ? 0 : 2;
