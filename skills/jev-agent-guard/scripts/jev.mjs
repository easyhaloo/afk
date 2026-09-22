#!/usr/bin/env node
import { createJevClient, redact } from './jev-client.mjs';

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    result[key] = next && !next.startsWith('--') ? (i++, next) : true;
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input ? JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(args.input, 'utf8'))) : JSON.parse(await readStdin());
  const client = createJevClient({ model: args.model, timeoutMs: args.timeout ? Number(args.timeout) : undefined });
  const state = JSON.parse(redact(input.state ?? {}));
  const result = await client.ask({ state, questions: input.questions ?? [], metadata: { source: 'jev-agent-guard', ...(input.metadata ?? {}) } });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8') || '{}';
}

main().catch(error => {
  process.stderr.write(`${error.code ?? 'jev_error'}: ${error.message}\n`);
  process.exit(error.code === 'missing_api_key' ? 4 : 3);
});
