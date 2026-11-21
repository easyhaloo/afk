import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [playwright, chromium, scratch] = process.argv.slice(2);
const output = mkdtempSync(join(scratch, 'render-'));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
try {
  const revision = git('rev-parse', 'HEAD');
  const blobs = {};
  for (const path of ['parcel.html', 'parcel.css']) {
    blobs[path] = git('hash-object', path);
    assert.equal(blobs[path], git('rev-parse', `HEAD:${path}`));
  }
  const probe = fileURLToPath(new URL('./browser-check.cjs', import.meta.url));
  const observation = join(output, 'render.json');
  const result = spawnSync(process.execPath, [probe, playwright, chromium], { encoding: 'utf8', timeout: 20000,
    env: { ...process.env, DEBUG: 'pw:browser', PARCEL_SCREENSHOT: join(output, 'render.png'), PARCEL_OBSERVATION: observation } });
  assert.ifError(result.error);
  assert.match(result.stderr, /<process did exit: exitCode=0, signal=null>/);
  assert.equal(readFileSync(join(output, 'render.png')).subarray(1, 4).toString(), 'PNG');
  const render = JSON.parse(readFileSync(observation));
  assert.deepEqual(JSON.parse(result.stdout), render);
  assert.equal(result.status, render.text === 'Parcel ready' && render.visible && render.width > 0 ? 0 : 1);
  console.log(JSON.stringify({ ...render, revision, blobs, browserExit: 0 }));
  process.exitCode = result.status;
} finally {
  rmSync(output, { recursive: true, force: true });
}
