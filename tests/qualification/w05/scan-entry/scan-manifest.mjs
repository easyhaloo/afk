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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('error: expected one JSON argument');
    let input;
    try { input = JSON.parse(process.argv[2]); }
    catch { throw new SyntaxError('error: invalid JSON'); }
    process.stdout.write(JSON.stringify(checkManifest(input)));
  } catch (error) {
    process.stderr.write(error.message);
    process.exitCode = 1;
  }
}
