import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ProposalCheck } from '../../../../packages/runtime/src/application/learning/proposals.js';
import { prepareProposalExperiment, proposalSemanticConfigurationSchema } from '../../../../packages/runtime/src/application/learning/proposal-semantics.js';

const controls = JSON.parse(readFileSync(new URL('./control-cases.json', import.meta.url), 'utf8'));
const fixture = fileURLToPath(new URL('./checkpoint.fixture.mjs', import.meta.url));
let scratch: string;
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'scan-entry-control-')); });
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

it.runIf(process.geteuid !== undefined && process.geteuid() !== 0)('independently witnesses denial of a write to the read-only synthetic asset', () => {
  const { target, original, replacement, expectedErrno } = controls.permissionWitness;
  const protectedPath = join(scratch, target);
  const writablePath = join(scratch, 'writable.txt');
  writeFileSync(protectedPath, original, { flag: 'wx' });
  chmodSync(protectedPath, 0o444);
  expect(statSync(protectedPath).mode & 0o777).toBe(0o444);
  writeFileSync(writablePath, original, { flag: 'wx' });
  const write = (path: string) => writeFileSync(path, replacement, { flag: 'r+' });
  write(writablePath);
  expect(readFileSync(writablePath, 'utf8')).toBe(replacement);
  expect(() => write(protectedPath)).toThrow(expect.objectContaining({ code: expectedErrno, path: protectedPath }));
  expect(readFileSync(protectedPath, 'utf8')).toBe(original);
});

it('prepares the bounded checker and observes partial, recovered and replayed checkpoints', () => {
  const check: ProposalCheck = controls.recovery.check;
  const { checkId, checkDigest } = controls.recovery.case;
  const configured = proposalSemanticConfigurationSchema.parse(controls.recovery.case.experiment);
  const prepared = prepareProposalExperiment('tool', 'checkpoint.fixture.mjs', check, configured, {
    type: 'object', properties: { phase: { type: 'string', enum: ['fault', 'resume'] }, manifest: { type: 'string' } },
    required: ['phase', 'manifest'], additionalProperties: false,
  });
  expect(prepared).toMatchObject({ status: 'prepared', experiment: { checkId, checkDigest } });
  const recovery = configured.recovery!;
  const checkpoint = join(scratch, recovery.resources[0]!.path);
  expect(() => statSync(checkpoint)).toThrow(expect.objectContaining({ code: 'ENOENT' }));

  for (const [phase, boundary, input] of [
    ['fault', 'fault', configured.callInput!],
    ['recovery', 'recovered', recovery.callInput],
    ['replay', 'replayed', recovery.callInput],
  ] as const) {
    const run = spawnSync(process.execPath, [fixture, input], { cwd: scratch, env: { TMPDIR: scratch }, timeout: 5000 });
    expect(run.error).toBeUndefined();
    expect({ exitCode: run.status, signal: run.signal, stdoutHex: run.stdout.toString('hex'), stderrHex: run.stderr.toString('hex') })
      .toEqual(recovery.returnAssertions[phase]);
    expect(readFileSync(checkpoint).toString('base64')).toBe(recovery.assertions[boundary][0]!.bytes);
  }
});
