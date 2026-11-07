import assert from 'node:assert/strict';
import test from 'node:test';
import { compactToolOutput } from '../scripts/context-filter.mjs';

const verbose = Array.from({ length: 250 }, (_, index) => `downloaded package-${index}`).join('\n');

test('successful dependency installation output is reduced with an explicit recovery hint', () => {
  const filtered = compactToolOutput({ command: 'npm ci', output: verbose, success: true });
  assert.ok(filtered.length < verbose.length / 2);
  assert.match(filtered, /re-run the command for full output/);
  assert.match(filtered, /package-0/);
  assert.match(filtered, /package-249/);
});

test('failures, warnings, tests, and explicit full-output requests are unchanged', () => {
  for (const option of [
    { command: 'npm ci', success: false },
    { command: 'npm ci', success: true, output: `${verbose}\nWARN peer mismatch` },
    { command: 'npm test', success: true },
    { command: 'npm ci', success: true, fullRequested: true },
  ]) {
    const output = option.output ?? verbose;
    assert.equal(compactToolOutput({ ...option, output }), output);
  }
});
