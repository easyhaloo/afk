import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { checkManifest } from './scan-manifest.mjs';

async function scan(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== 2 || typeof input.manifest !== 'string'
    || !['fault', 'resume', 'wait'].includes(input.phase)) return checkManifest(input);
  const { phase, manifest } = input;
  if (phase === 'wait') {
    await setTimeout(10_000);
    return checkManifest(manifest);
  }

  const lines = manifest.split('\n');
  assert.ok(lines.length >= 2);
  const scratch = process.env.TMPDIR;
  assert.ok(scratch);
  const path = join(scratch, 'scan-checkpoint.json');

  if (phase === 'fault') {
    const { invalidLines } = checkManifest(lines[0]);
    writeFileSync(path, JSON.stringify({ manifest, nextLine: 1, invalidLines }), { flag: 'wx' });
    process.exit(23);
  }

  const checkpoint = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(checkpoint.manifest, manifest);
  assert.ok(checkpoint.nextLine === 1 || checkpoint.nextLine === lines.length);
  assert.ok(Array.isArray(checkpoint.invalidLines) && checkpoint.invalidLines.every((line, index, invalid) =>
    Number.isSafeInteger(line) && line > (invalid[index - 1] ?? 0) && line <= checkpoint.nextLine));
  if (checkpoint.nextLine < lines.length) {
    const { invalidLines } = checkManifest(lines.slice(checkpoint.nextLine).join('\n'));
    checkpoint.invalidLines.push(...invalidLines.map(line => line + checkpoint.nextLine));
    checkpoint.nextLine = lines.length;
    const staging = mkdtempSync(join(scratch, 'scan-checkpoint-'));
    try {
      const next = join(staging, 'state.json');
      writeFileSync(next, JSON.stringify(checkpoint), { flag: 'wx' });
      renameSync(next, path);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  return { checked: checkpoint.nextLine, invalidLines: checkpoint.invalidLines };
}

try {
  if (process.argv.length !== 3) throw new Error('error: expected one JSON argument');
  let input;
  try { input = JSON.parse(process.argv[2]); }
  catch { throw new SyntaxError('error: invalid JSON'); }
  process.stdout.write(JSON.stringify(await scan(input)));
} catch (error) {
  process.stderr.write(error.message);
  process.exitCode = 1;
}
