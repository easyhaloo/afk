import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ProposalCheck } from '../../../../packages/runtime/src/application/learning/proposals.js';
import { prepareProposalExperiment, proposalSemanticConfigurationSchema } from '../../../../packages/runtime/src/application/learning/proposal-semantics.js';

const controls = JSON.parse(readFileSync(new URL('./control-cases.json', import.meta.url), 'utf8'));
const historicalCases = (JSON.parse(readFileSync(new URL('./checker-cases.json', import.meta.url), 'utf8')) as
  { checkId: string; experiment: unknown }[]).map(({ checkId, experiment }) =>
  ({ checkId, ...proposalSemanticConfigurationSchema.parse(experiment) }));
const inputSchema = {
  anyOf: [
    { type: 'string' },
    { type: 'object', properties: { phase: { type: 'string', enum: ['fault', 'resume', 'wait'] }, manifest: { type: 'string' } },
      required: ['phase', 'manifest'], additionalProperties: false },
  ],
};
const fixture = fileURLToPath(new URL('./checkpoint.fixture.mjs', import.meta.url));
let scratch: string;
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'scan-entry-control-')); });
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

it.each(historicalCases.filter(({ kind }) => kind === 'normal' || kind === 'refusal'))('preserves $checkId on the checkpoint entry point', ({ input, assertions }) => {
  const run = spawnSync(process.execPath, [fixture, input], { cwd: scratch, timeout: 5000, encoding: 'utf8' });
  expect(run.error).toBeUndefined();
  expect(run.status).toBe(assertions.find(({ source }) => source === 'exit-code')!.expected);
  const output = assertions.find(({ id }) => id === 'output')!;
  expect(output.source === 'stderr' ? run.stderr : JSON.parse(run.stdout)).toEqual(output.expected);
  expect(readdirSync(scratch)).toEqual([]);
});

it.each(historicalCases.filter(({ control }) => control))('keeps $checkId in flight until the host interrupts it', ({ checkId, ...experiment }) => {
  const check: ProposalCheck = { id: checkId, kind: experiment.kind, input: experiment.input, expected: 'Host terminates the in-flight scan' };
  const callInput = JSON.stringify({ phase: 'wait', manifest: JSON.parse(experiment.callInput!) });
  const prepared = prepareProposalExperiment('tool', 'checkpoint.fixture.mjs', check, { ...experiment, callInput }, inputSchema);
  expect(prepared.status).toBe('prepared');
  const run = spawnSync(process.execPath, [fixture, callInput], { cwd: scratch, env: { TMPDIR: scratch },
    timeout: experiment.control!.afterMs, killSignal: 'SIGKILL', encoding: 'utf8' });
  expect(run.error).toMatchObject({ code: 'ETIMEDOUT' });
  expect(run.signal).toBe('SIGKILL');
  expect([run.stdout, run.stderr]).toEqual(['', '']);
  expect(readdirSync(scratch)).toEqual([]);
}, 10_000);

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
  const prepared = prepareProposalExperiment('tool', 'checkpoint.fixture.mjs', check, configured, inputSchema);
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

it('resumes a multi-line manifest and preserves the checkpoint on refusal and replay', () => {
  const manifest = 'bad-first\n9780306406157\nbad-third\n5901234123457';
  const checkpoint = join(scratch, 'scan-checkpoint.json');
  const run = (phase: 'fault' | 'resume', input: string) => spawnSync(process.execPath,
    [fixture, JSON.stringify({ phase, manifest: input })], { cwd: scratch, env: { TMPDIR: scratch }, timeout: 5000 });
  expect(run('fault', manifest).status).toBe(23);
  const partial = readFileSync(checkpoint, 'utf8');
  expect(JSON.parse(partial)).toEqual({ manifest, nextLine: 1, invalidLines: [1] });

  const refused = run('resume', manifest.replace('bad-third', 'different'));
  expect(refused.status).toBe(1);
  expect(readFileSync(checkpoint, 'utf8')).toBe(partial);

  const interruptedStage = join(scratch, 'scan-checkpoint-interrupted');
  mkdirSync(interruptedStage);
  writeFileSync(join(interruptedStage, 'state.json'), '{');
  const recovered = run('resume', manifest);
  const output = { checked: 4, invalidLines: [1, 3] };
  expect(recovered.status).toBe(0);
  expect(JSON.parse(recovered.stdout.toString('utf8'))).toEqual(output);
  const final = readFileSync(checkpoint, 'utf8');
  expect(JSON.parse(final)).toEqual({ manifest, nextLine: 4, invalidLines: output.invalidLines });
  const replayed = run('resume', manifest);
  expect(replayed.status).toBe(0);
  expect(replayed.stdout).toEqual(recovered.stdout);
  expect(readFileSync(checkpoint, 'utf8')).toBe(final);
});
