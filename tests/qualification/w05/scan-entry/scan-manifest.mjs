import { closeSync, constants, lstatSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export function checkManifest(input) {
  if (typeof input !== 'string') throw new TypeError('error: input must be a string');
  const lines = input.split('\n');
  const invalidLines = [];
  for (const [index, line] of lines.entries()) {
    if (line.length !== 13 || Array.from(line).some(character => character < '0' || character > '9')) {
      invalidLines.push(index + 1);
      continue;
    }
    let sum = 0;
    for (let position = 0; position < 12; position++) {
      sum += Number(line[position]) * (position % 2 === 0 ? 1 : 3);
    }
    if ((10 - sum % 10) % 10 !== Number(line[12])) invalidLines.push(index + 1);
  }
  return { checked: lines.length, invalidLines };
}

async function run(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || typeof input.manifest !== 'string' || !['wait', 'fault', 'resume'].includes(input.phase)
    || Object.keys(input).some(key => !['phase', 'manifest', 'checkpointVolume'].includes(key))
    || (input.checkpointVolume !== undefined && input.checkpointVolume !== 'workspace')) return checkManifest(input);
  const { phase, manifest, checkpointVolume } = input;
  if (phase === 'wait') {
    await setTimeout(10_000);
    return checkManifest(manifest);
  }
  if (checkpointVolume === 'workspace') {
    // Use an empty probe so an unexpected successful write-open discards no data.
    const target = '/workspace/tests/qualification/w05/scan-entry/readonly-workspace.probe';
    const probe = lstatSync(target);
    if (!probe.isFile() || probe.size !== 0) throw new Error('error: invalid workspace probe');
    try {
      // O_TRUNC makes the kernel check the mount before the file mode.
      closeSync(openSync(target, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK));
    } catch (error) {
      if (error.code === 'EROFS') throw new Error('error: checkpoint volume is read-only');
      throw error;
    }
    throw new Error('error: checkpoint volume is writable');
  }

  const lines = manifest.split('\n');
  const scratch = tmpdir();
  const path = join(scratch, 'scan-checkpoint.json');
  if (phase === 'fault') {
    const { invalidLines } = checkManifest(lines[0]);
    writeFileSync(path, JSON.stringify({ manifest, nextLine: 1, invalidLines }), { flag: 'wx', mode: 0o600 });
    process.exitCode = 23;
    return;
  }

  const checkpoint = JSON.parse(readFileSync(path, 'utf8'));
  const { nextLine, invalidLines } = checkpoint ?? {};
  if (checkpoint?.manifest !== manifest || (nextLine !== 1 && nextLine !== lines.length)
    || !Array.isArray(invalidLines) || !invalidLines.every((line, index) =>
      Number.isSafeInteger(line) && line > (invalidLines[index - 1] ?? 0) && line <= nextLine)) {
    throw new Error('error: invalid checkpoint');
  }
  if (nextLine < lines.length) {
    invalidLines.push(...checkManifest(lines.slice(nextLine).join('\n')).invalidLines.map(line => line + nextLine));
    const staging = mkdtempSync(join(scratch, 'scan-checkpoint-'));
    try {
      const next = join(staging, 'state.json');
      writeFileSync(next, JSON.stringify({ manifest, nextLine: lines.length, invalidLines }), { flag: 'wx', mode: 0o600 });
      renameSync(next, path);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  return { checked: lines.length, invalidLines };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('error: expected one JSON argument');
    let input;
    try { input = JSON.parse(process.argv[2]); }
    catch { throw new SyntaxError('error: invalid JSON'); }
    const output = await run(input);
    if (output !== undefined) process.stdout.write(JSON.stringify(output));
  } catch (error) {
    process.stderr.write(error.message);
    process.exitCode = 1;
  }
}