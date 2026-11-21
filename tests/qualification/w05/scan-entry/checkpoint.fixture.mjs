import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkManifest } from './scan-manifest.mjs';

const { phase, manifest } = JSON.parse(process.argv[2]);
const lines = manifest.split('\n');
assert.equal(lines.length, 2);
const scratch = process.env.TMPDIR;
assert.ok(scratch);
const path = join(scratch, 'scan-checkpoint.json');

if (phase === 'fault') {
  const { invalidLines } = checkManifest(lines[0]);
  writeFileSync(path, JSON.stringify({ manifest, nextLine: 1, invalidLines }), { flag: 'wx' });
  process.exit(23);
}

assert.equal(phase, 'resume');
const checkpoint = JSON.parse(readFileSync(path, 'utf8'));
assert.equal(checkpoint.manifest, manifest);
assert.ok(checkpoint.nextLine === 1 || checkpoint.nextLine === lines.length);
if (checkpoint.nextLine === 1) {
  const { invalidLines } = checkManifest(lines[1]);
  checkpoint.invalidLines.push(...invalidLines.map(line => line + checkpoint.nextLine));
  checkpoint.nextLine = lines.length;
  writeFileSync(path, JSON.stringify(checkpoint));
}
process.stdout.write(JSON.stringify({ checked: checkpoint.nextLine, invalidLines: checkpoint.invalidLines }));
