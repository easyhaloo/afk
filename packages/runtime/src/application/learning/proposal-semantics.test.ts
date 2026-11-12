import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FrozenExecutionResult } from '../../infrastructure/sandbox/container/frozen-execution.js';
import type { ProposalCheck } from './proposals.js';
import { canonicalLearningJson } from './requests.js';

const check: ProposalCheck = { id: 'normal-alpha', kind: 'normal', input: '{"key":"alpha"}', expected: 'Candidate claim is not the oracle' };
const experiment = () => ({ protocol: 'proposal-semantic-v1', adapter: 'node-json-argv-v1', kind: check.kind, input: check.input,
  assertions: [{ id: 'exit', source: 'exit-code', expected: 0 }, { id: 'value', source: 'stdout-json', path: ['value'], expected: 'alpha' }] });
const result = (stdout = '{"value":"alpha"}', exitCode = 0) => ({ exitCode, stdout, stderr: '',
  evidence: { argv: ['/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/scratch', 'TMPDIR=/scratch',
    'node', '/workspace/asset.js', check.input] }, cleanup: { containerRemoved: true, imageRemoved: true } }) as unknown as FrozenExecutionResult;
const digest = (value: unknown) => createHash('sha256').update(canonicalLearningJson(value)).digest('hex');

async function implementation() {
  const modulePath = './proposal-semantics.js';
  const module = await import(modulePath).catch(() => undefined) as typeof import('./proposal-semantics.js') | undefined;
  expect(module?.prepareProposalExperiment).toBeTypeOf('function');
  expect(module?.observeProposalExperiment).toBeTypeOf('function');
  return module!;
}

describe('proposal semantic observations', () => {
  it('derives typed assertions from actual output and binds delivered input', async () => {
    const module = await implementation();
    const prepared = module.prepareProposalExperiment('tool', 'asset.js', check, experiment());
    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') throw new Error('Missing prepared experiment');
    const observed = module.observeProposalExperiment(prepared.experiment, result());
    expect(observed.passed).toBe(true);
    expect(observed.experimentDigest).toBe(digest(prepared.experiment));
    expect(observed.deliveredInputDigest).toBe(createHash('sha256').update(check.input).digest('hex'));
    expect(observed.assertions.map(entry => entry.actual)).toEqual([0, 'alpha']);
  });

  it('rejects constant output that ignores the required input semantics', async () => {
    const module = await implementation();
    const prepared = module.prepareProposalExperiment('tool', 'asset.js', check, experiment());
    if (prepared.status !== 'prepared') throw new Error('Missing prepared experiment');
    expect(module.observeProposalExperiment(prepared.experiment, result('{"value":"constant"}')).passed).toBe(false);
  });

  it.each(['length', '01', '-1', '99999999999999999999'])('does not treat array metadata or noncanonical index %s as a JSON member', async segment => {
    const module = await implementation();
    const configured = { ...experiment(), assertions: [experiment().assertions[0],
      { id: 'member', source: 'stdout-json', path: ['payload', segment], expected: 0 }] };
    const prepared = module.prepareProposalExperiment('tool', 'asset.js', check, configured);
    if (prepared.status !== 'prepared') throw new Error('Missing prepared experiment');
    const observed = module.observeProposalExperiment(prepared.experiment, result('{"payload":[]}'));
    expect(observed.assertions[1]).toMatchObject({ status: 'unknown', passed: false });
    expect(observed.passed).toBe(false);
  });

  it.each(['missing', 'different', 'extra', 'target'] as const)('rejects %s actual invocation input', async drift => {
    const module = await implementation();
    const prepared = module.prepareProposalExperiment('tool', 'asset.js', check, experiment());
    if (prepared.status !== 'prepared') throw new Error('Missing prepared experiment');
    const execution = result();
    const argv = [...execution.evidence.argv];
    if (drift === 'missing') argv.pop();
    if (drift === 'different') argv[argv.length - 1] = '{}';
    if (drift === 'extra') argv.push('unbound');
    if (drift === 'target') argv[argv.length - 2] = '/workspace/other.js';
    expect(() => module.observeProposalExperiment(prepared.experiment, { ...execution, evidence: { ...execution.evidence, argv } })).toThrow();
  });

  it.each(['missing', 'invalid-json', 'inherited', 'oversized'] as const)('keeps %s output unverified', async invalid => {
    const module = await implementation();
    const prepared = module.prepareProposalExperiment('tool', 'asset.js', check, experiment());
    if (prepared.status !== 'prepared') throw new Error('Missing prepared experiment');
    const stdout = invalid === 'missing' ? '{}' : invalid === 'invalid-json' ? 'not-json'
      : invalid === 'inherited' ? '{"__proto__":{"value":"alpha"}}' : JSON.stringify({ value: 'a'.repeat(1024 * 1024) });
    expect(module.observeProposalExperiment(prepared.experiment, result(stdout)).passed).toBe(false);
  });

  it.each(['input', 'kind', 'duplicate', 'exit', 'unknown', 'path', 'non-json', 'empty'] as const)('rejects invalid %s configuration before execution', async invalid => {
    const module = await implementation();
    const configured: { [key: string]: unknown } = experiment();
    if (invalid === 'input') configured.input = '{}';
    if (invalid === 'kind') configured.kind = 'refusal';
    if (invalid === 'duplicate') configured.assertions = [experiment().assertions[0], experiment().assertions[0]];
    if (invalid === 'exit') configured.assertions = [experiment().assertions[1]];
    if (invalid === 'unknown') configured.passed = true;
    if (invalid === 'path') configured.assertions = [{ id: 'value', source: 'stdout-json', path: ['__proto__'], expected: {} }];
    if (invalid === 'non-json') configured.assertions = [{ id: 'value', source: 'stdout-json', path: ['value'], expected: NaN }];
    if (invalid === 'empty') configured.assertions = [];
    expect(() => module.prepareProposalExperiment('tool', 'asset.js', check, configured)).toThrow();
  });

  it('accepts an observed nonzero refusal without treating exit zero as refusal', async () => {
    const module = await implementation();
    const refused: ProposalCheck = { ...check, kind: 'refusal' };
    const configured = { ...experiment(), kind: 'refusal', assertions: [
      { id: 'exit', source: 'exit-code', expected: 2 }, { id: 'reason', source: 'stderr', expected: 'Invalid input' }] };
    const prepared = module.prepareProposalExperiment('tool', 'asset.js', refused, configured);
    if (prepared.status !== 'prepared') throw new Error('Missing prepared experiment');
    expect(module.observeProposalExperiment(prepared.experiment, { ...result('', 2), stderr: 'Invalid input' }).passed).toBe(true);
    expect(module.observeProposalExperiment(prepared.experiment, { ...result('', 0), stderr: 'Invalid input' }).passed).toBe(false);
  });

  it('delivers malformed JSON to the tool for an actual refusal experiment', async () => {
    const module = await implementation();
    const refused = { ...check, kind: 'refusal' as const, input: '{broken' };
    const prepared = module.prepareProposalExperiment('tool', 'asset.js', refused, { ...experiment(), kind: refused.kind, input: refused.input,
      assertions: [{ id: 'exit', source: 'exit-code', expected: 2 }, { id: 'reason', source: 'stderr', expected: 'Invalid input' }] });
    if (prepared.status !== 'prepared') throw new Error('Missing prepared experiment');
    expect(prepared.experiment.argv.at(-1)).toBe('{broken');
    const execution = result('', 2);
    const observed = module.observeProposalExperiment(prepared.experiment, { ...execution, stderr: 'Invalid input', evidence: {
      ...execution.evidence, argv: [...execution.evidence.argv.slice(0, -1), refused.input] } });
    expect(observed.passed).toBe(true);
  });

  it.each(['recovery', 'permission-denied'] as const)('does not qualify %s from ordinary output assertions', async kind => {
    const module = await implementation();
    expect(module.prepareProposalExperiment('tool', 'asset.js', { ...check, kind }, { ...experiment(), kind }))
      .toMatchObject({ status: 'unsupported' });
  });

  it.each(['cancellation', 'timeout'] as const)('requires actual host %s control rather than a printed claim', async kind => {
    const module = await implementation();
    const controlled = { ...experiment(), kind, control: { kind, afterMs: 10 }, assertions: [
      { id: 'exit', source: 'exit-code', expected: 137 }, { id: 'control', source: 'control', path: ['kind'], expected: kind }] };
    const prepared = module.prepareProposalExperiment('tool', 'asset.js', { ...check, kind }, controlled);
    if (prepared.status !== 'prepared') throw new Error('Missing prepared experiment');
    expect(() => module.observeProposalExperiment(prepared.experiment, result('{"cancelled":true}', 137))).toThrow(/control/i);
    const execution: FrozenExecutionResult = { ...result('', 137), evidence: { ...result().evidence, operationId: 'owned-operation', containerId: 'owned-container',
      control: { kind, afterMs: 10, trigger: kind === 'timeout' ? 'host-deadline' : 'host-cancellation', signal: 'SIGKILL',
        operationId: 'owned-operation', containerId: 'owned-container', exitCode: 137, runningObservedMs: 1, triggeredMs: 12, terminatedMs: 13 } } };
    expect(module.observeProposalExperiment(prepared.experiment, execution).passed).toBe(true);
    for (const change of [{ operationId: 'foreign' }, { containerId: 'foreign' }, { afterMs: 9 }, { triggeredMs: 2 }, { terminatedMs: 0 }, { triggeredMs: NaN }]) {
      expect(() => module.observeProposalExperiment(prepared.experiment, { ...execution, evidence: { ...execution.evidence,
        control: { ...execution.evidence.control!, ...change } } })).toThrow(/control/i);
    }
  });

  it('does not claim a JavaScript command interprets a skill', async () => {
    const module = await implementation();
    expect(module.prepareProposalExperiment('skill', 'SKILL.md', check, experiment())).toMatchObject({ status: 'unsupported' });
  });
});
