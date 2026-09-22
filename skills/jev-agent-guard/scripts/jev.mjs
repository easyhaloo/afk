#!/usr/bin/env node
import fs from 'node:fs/promises';
import { choice, noul, score } from './jev-client.mjs';
import { askJev } from './jev-client.mjs';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    result[key] = next && !next.startsWith('--') ? (index++, next) : true;
  }
  return result;
}

async function readInput(file) {
  const raw = file ? await fs.readFile(file, 'utf8') : await readStdin();
  return JSON.parse(raw || '{}');
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function buildQuestions(specification = {}) {
  return Object.fromEntries(Object.entries(specification).map(([name, question]) => {
    if (!question || typeof question !== 'object') throw new Error(`invalid question '${name}'`);
    const prompt = question.instructions ?? question.prompt;
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error(`question '${name}' needs instructions`);
    switch (question.type) {
      case 'choice':
        return [name, choice(prompt, question.criteria ?? question.options ?? {})];
      case 'noul':
      case 'boolean':
        return [name, noul(prompt)];
      case 'score':
        return [name, score(prompt, question.criteria ?? question.levels ?? [])];
      default:
        throw new Error(`unsupported question type for '${name}': ${question.type}`);
    }
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = await readInput(args.input);
  const response = await askJev({
    state: input.state ?? {},
    questions: buildQuestions(input.questions ?? {}),
    options: args.model ? { model: args.model } : undefined,
  });
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.code ?? 'jev_error'}: ${error.message}\n`);
  process.exit(error.code === 'missing_api_key' ? 4 : 3);
});
