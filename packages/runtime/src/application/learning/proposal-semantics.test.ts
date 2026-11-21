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
const inputSchema = { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false };
const recoveryCheck: ProposalCheck = { ...check, kind: 'recovery', input: 'Recover an interrupted operation' };
const recoveryExperiment = () => ({ ...experiment(), kind: recoveryCheck.kind, input: recoveryCheck.input, callInput: '{"key":"fault"}',
  assertions: [{ id: 'exit', source: 'exit-code', expected: 0 }, { id: 'reason', source: 'stderr', expected: 'fault' }],
  recovery: { contractRevision: 'bounded-recovery-return-state-v1', resources: [{ id: 'state', path: 'data/state.bin' }],
    callInput: '{"key":"recovered"}', requireEffectHistory: false,
    assertions: { fault: [{ id: 'state', path: 'data/state.bin', bytes: 'cGFydGlhbA==' }],
      recovered: [{ id: 'state', path: 'data/state.bin', bytes: 'ZG9uZQ==' }], replayed: [{ id: 'state', path: 'data/state.bin', bytes: 'ZG9uZQ==' }] },
    returnAssertions: { fault: { exitCode: 2, signal: null, stdoutHex: '', stderrHex: '6661756c74' },
      recovery: { exitCode: 0, signal: null, stdoutHex: '6f6b', stderrHex: '' }, replay: { exitCode: 0, signal: null, stdoutHex: '6f6b', stderrHex: '' } } } });

async function implementation() {
  const modulePath = './proposal-semantics.js';
  const module = await import(modulePath).catch(() => undefined) as typeof import('./proposal-semantics.js') | undefined;
  expect(module?.prepareProposalExperiment).toBeTypeOf('function');
  expect(module?.observeProposalExperiment).toBeTypeOf('function');
  return module!;
}

describe('proposal semantic observations', () => {
  it('preserves absent-field preparation and observation digests for a legacy experiment', async () => {
    const module = await implementation();
    const prepared = module.prepareProposalExperiment('tool', 'asset.js', check, experiment());
    if (prepared.status !== 'prepared') throw new Error('Missing prepared experiment');
    const legacy = { ...experiment(), checkId: check.id, checkDigest: digest(check), artifactPath: 'asset.js',
      argv: ['node', '/workspace/asset.js', check.input] };
    expect(prepared.experiment).toEqual(legacy);
    expect(Object.hasOwn(prepared.experiment, 'recovery')).toBe(false);
    expect(Object.hasOwn(prepared.experiment, 'callInput')).toBe(false);
    expect(module.observeProposalExperiment(prepared.experiment, result()).experimentDigest).toBe(digest(legacy));
  });

  it('prepares versioned recovery with relative artifact argv and distinct business inputs', async () => {
    const module = await implementation();
    const configured = recoveryExperiment();
    const prepared = module.prepareProposalExperiment('tool', 'dir/asset.js', recoveryCheck, configured, inputSchema);
    if (prepared.status !== 'prepared') throw new Error('Missing prepared recovery experiment');
    expect(prepared.experiment).toEqual({ ...configured, checkId: recoveryCheck.id, checkDigest: digest(recoveryCheck),
      artifactPath: 'dir/asset.js', argv: ['node', 'dir/asset.js', configured.callInput] });
    expect(prepared.experiment.argv[2]).not.toBe(configured.input);
    expect(prepared.experiment.argv[2]).not.toBe(configured.recovery.callInput);
    expect(module.prepareProposalExperiment('skill', 'SKILL.md', recoveryCheck, configured, inputSchema))
      .toEqual({ status: 'unsupported', reason: 'skill_interpreter_unavailable' });
  });

  it('keeps missing recovery input, schema and effect history explicitly unsupported', async () => {
    const module = await implementation();
    const configured = recoveryExperiment();
    expect(module.prepareProposalExperiment('tool', 'asset.js', recoveryCheck, configured))
      .toEqual({ status: 'unsupported', reason: 'recovery_input_unavailable' });
    const missingInput = Object.fromEntries(Object.entries(configured).filter(([key]) => key !== 'callInput'));
    expect(module.prepareProposalExperiment('tool', 'asset.js', recoveryCheck, missingInput, inputSchema))
      .toEqual({ status: 'unsupported', reason: 'recovery_input_unavailable' });
    expect(module.prepareProposalExperiment('tool', 'asset.js', recoveryCheck, { ...configured,
      recovery: { ...configured.recovery, requireEffectHistory: true } }, inputSchema))
      .toEqual({ status: 'unsupported', reason: 'recovery_effect_history_unsupported' });
  });

  it.each(['fault', 'recovery'] as const)('validates JSON, tool schema and parameter paths for the %s business input', async phase => {
    const module = await implementation();
    for (const callInput of ['invalid', '{}', '{"key":2}', '{"key":"value","extra":true}', '{"key":"/etc/passwd"}',
      '{"key":"C:\\\\secret"}', '{"key":"file:secret"}', '{"key":"alpha"}\0',
      JSON.stringify(Array.from({ length: 34 }).reduce(value => [value], [] as unknown[]))]) {
      const configured = recoveryExperiment();
      const invalid = phase === 'fault' ? { ...configured, callInput } : { ...configured, recovery: { ...configured.recovery, callInput } };
      expect(() => module.prepareProposalExperiment('tool', 'asset.js', recoveryCheck, invalid, inputSchema), callInput).toThrow();
    }
  });

  it('rejects recovery on other kinds, host control and identical business bytes', async () => {
    const module = await implementation();
    const configured = recoveryExperiment();
    for (const kind of ['normal', 'refusal', 'timeout', 'permission-denied'] as const) {
      expect(() => module.prepareProposalExperiment('tool', 'asset.js', { ...recoveryCheck, kind }, { ...configured, kind }, inputSchema)).toThrow(/recovery/);
    }
    expect(() => module.prepareProposalExperiment('tool', 'asset.js', recoveryCheck,
      { ...configured, control: { kind: 'timeout', afterMs: 10 } }, inputSchema)).toThrow(/control/);
    expect(() => module.prepareProposalExperiment('tool', 'asset.js', recoveryCheck,
      { ...configured, recovery: { ...configured.recovery, callInput: configured.callInput } }, inputSchema)).toThrow(/distinct/);
  });

  it('requires helper exit zero independently of the nonzero fault return', async () => {
    const module = await implementation();
    const configured = recoveryExperiment();
    expect(module.prepareProposalExperiment('tool', 'asset.js', recoveryCheck, configured, inputSchema).status).toBe('prepared');
    expect(() => module.prepareProposalExperiment('tool', 'asset.js', recoveryCheck, { ...configured,
      assertions: [{ ...configured.assertions[0], expected: 2 }, configured.assertions[1]] }, inputSchema)).toThrow(/outcome/);
    expect(() => module.prepareProposalExperiment('tool', 'asset.js', recoveryCheck, { ...configured, recovery: { ...configured.recovery,
      returnAssertions: { ...configured.recovery.returnAssertions, fault: { ...configured.recovery.returnAssertions.fault, exitCode: 0 } } } }, inputSchema)).toThrow();
  });

  it('requires every strict recovery contract field and every saved return outcome field', async () => {
    const module = await implementation();
    const configured = recoveryExperiment();
    const without = (value: object, key: string) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
    const invalidContracts: unknown[] = [null, { ...configured.recovery, contractRevision: 'bounded-recovery-return-state-v2' },
      { ...configured.recovery, helper: '/untrusted' }, { ...configured.recovery, assertions: { ...configured.recovery.assertions, extra: [] } },
      { ...configured.recovery, returnAssertions: { ...configured.recovery.returnAssertions, extra: {} } }];
    for (const key of Object.keys(configured.recovery)) invalidContracts.push(without(configured.recovery, key));
    for (const phase of ['fault', 'recovery', 'replay'] as const) {
      invalidContracts.push({ ...configured.recovery, returnAssertions: without(configured.recovery.returnAssertions, phase) });
      for (const key of Object.keys(configured.recovery.returnAssertions[phase])) invalidContracts.push({ ...configured.recovery,
        returnAssertions: { ...configured.recovery.returnAssertions, [phase]: without(configured.recovery.returnAssertions[phase], key) } });
    }
    for (const recovery of invalidContracts) {
      expect(() => module.prepareProposalExperiment('tool', 'asset.js', recoveryCheck, { ...configured, recovery }, inputSchema)).toThrow();
    }
    expect(module.prepareProposalExperiment('tool', 'asset.js', recoveryCheck, { ...configured, recovery: undefined }, inputSchema))
      .toEqual({ status: 'unsupported', reason: 'recovery_contract_unavailable' });
  });

  it('rejects malformed return bytes and outcomes and bounds aggregate decoded output at 32 KiB', async () => {
    const module = await implementation();
    const configured = recoveryExperiment();
    const returns = configured.recovery.returnAssertions;
    for (const phase of ['fault', 'recovery', 'replay'] as const) for (const change of [
      { stdoutHex: 'Ff' }, { stderrHex: 'f' }, { stdoutHex: 'gg' }, { stdoutHex: null }, { stdoutHex: '00'.repeat(32769) },
      { signal: 'SIGKILL' }, { exitCode: phase === 'fault' ? 0 : 1 }, { exitCode: 256 }, { exitCode: 1.5 }, { extra: true },
    ]) expect(() => module.prepareProposalExperiment('tool', 'asset.js', recoveryCheck, { ...configured, recovery: { ...configured.recovery,
      returnAssertions: { ...returns, [phase]: { ...returns[phase], ...change } } } }, inputSchema)).toThrow();
    const bounded = { fault: { ...returns.fault, stdoutHex: '00'.repeat(32768), stderrHex: '' },
      recovery: { ...returns.recovery, stdoutHex: '' }, replay: { ...returns.replay, stdoutHex: '' } };
    expect(module.prepareProposalExperiment('tool', 'asset.js', recoveryCheck, { ...configured,
      recovery: { ...configured.recovery, returnAssertions: bounded } }, inputSchema).status).toBe('prepared');
    expect(() => module.prepareProposalExperiment('tool', 'asset.js', recoveryCheck, { ...configured, recovery: { ...configured.recovery,
      returnAssertions: { ...bounded, replay: { ...bounded.replay, stderrHex: '00' } } } }, inputSchema)).toThrow();
  });

  it('enforces canonical state bytes, ordered unique resources, fault distinction and terminal idempotency', async () => {
    const module = await implementation();
    const configured = recoveryExperiment();
    const recovery = configured.recovery;
    for (const resources of [[], Array(5).fill(recovery.resources[0]), [recovery.resources[0], recovery.resources[0]],
      [{ ...recovery.resources[0], extra: true }], [recovery.resources[0], { id: 'state', path: 'other' }],
      [recovery.resources[0], { id: 'other', path: recovery.resources[0].path }], [{ id: 'bad id', path: 'state' }],
      [{ id: 'x'.repeat(33), path: 'state' }], [{ id: 'state', path: 'x'.repeat(65) }],
      ...['/state', '../state', 'data//state', 'data\\state', '.git/state'].map(path => ({ id: 'state', path })).map(resource => [resource])]) {
      expect(() => module.prepareProposalExperiment('tool', 'asset.js', recoveryCheck, { ...configured, recovery: { ...recovery, resources } }, inputSchema)).toThrow();
    }
    for (const fault of [[], [{ ...recovery.assertions.fault[0], id: 'other' }], [{ ...recovery.assertions.fault[0], path: 'other' }],
      [{ ...recovery.assertions.fault[0], extra: true }], [{ id: 'state', path: 'data/state.bin' }],
      ...[null, 'YQ', 'YR==', Buffer.alloc(16385).toString('base64'), recovery.assertions.recovered[0].bytes]
        .map(bytes => [{ ...recovery.assertions.fault[0], bytes }])]) {
      expect(() => module.prepareProposalExperiment('tool', 'asset.js', recoveryCheck, { ...configured, recovery: { ...recovery,
        assertions: { ...recovery.assertions, fault } } }, inputSchema)).toThrow();
    }
    expect(() => module.prepareProposalExperiment('tool', 'asset.js', recoveryCheck, { ...configured, recovery: { ...recovery,
      assertions: { ...recovery.assertions, replayed: recovery.assertions.fault } } }, inputSchema)).toThrow();
    const terminal = [{ ...recovery.assertions.recovered[0], bytes: null }];
    for (const bytes of ['', Buffer.alloc(16384).toString('base64')]) expect(module.prepareProposalExperiment('tool', 'asset.js', recoveryCheck,
      { ...configured, recovery: { ...recovery, assertions: { fault: [{ ...recovery.assertions.fault[0], bytes }], recovered: terminal, replayed: terminal } } }, inputSchema).status).toBe('prepared');
  });

  it('accepts four resources and rejects reordered or incomplete state snapshots', async () => {
    const module = await implementation();
    const configured = recoveryExperiment();
    const resources = Array.from({ length: 4 }, (_, index) => ({ id: `state-${index}`, path: `data/state-${index}` }));
    const fault = resources.map(resource => ({ ...resource, bytes: '' }));
    const recovered = resources.map(resource => ({ ...resource, bytes: null }));
    const assertions = { fault, recovered, replayed: recovered };
    expect(module.prepareProposalExperiment('tool', 'asset.js', recoveryCheck,
      { ...configured, recovery: { ...configured.recovery, resources, assertions } }, inputSchema).status).toBe('prepared');
    for (const invalid of [{ ...assertions, fault: fault.slice(1) }, { ...assertions, recovered: [...recovered].reverse() }]) {
      expect(() => module.prepareProposalExperiment('tool', 'asset.js', recoveryCheck,
        { ...configured, recovery: { ...configured.recovery, resources, assertions: invalid } }, inputSchema)).toThrow();
    }
  });

  it.each(['cancellation', 'timeout'] as const)('separates the %s scenario from schema-validated business bytes', async kind => {
    const module = await implementation();
    const scenario = { ...check, kind, input: 'Host interrupts a business operation' };
    const callInput = '{ "key": "beta" }';
    const configured = { ...experiment(), kind, input: scenario.input, callInput, control: { kind, afterMs: 10 }, assertions: [
      { id: 'exit', source: 'exit-code', expected: 137 }, { id: 'host', source: 'control', path: ['kind'], expected: kind }] };
    const prepared = module.prepareProposalExperiment('tool', 'asset.js', scenario, configured, inputSchema);
    if (prepared.status !== 'prepared') throw new Error('Missing prepared experiment');
    expect(prepared.experiment).toMatchObject({ input: scenario.input, callInput, checkDigest: digest(scenario), argv: ['node', '/workspace/asset.js', callInput] });
    const execution: FrozenExecutionResult = { ...result('', 137), evidence: { ...result().evidence,
      argv: [...result().evidence.argv.slice(0, -1), callInput], operationId: 'owned-operation', containerId: 'owned-container',
      control: { kind, afterMs: 10, outcome: 'triggered', trigger: kind === 'timeout' ? 'host-deadline' : 'host-cancellation',
        signal: 'SIGKILL', operationId: 'owned-operation', containerId: 'owned-container', exitCode: 137, runningObservedMs: 1, triggeredMs: 12, terminatedMs: 13 } } };
    const observed = module.observeProposalExperiment(prepared.experiment, execution);
    expect(observed.passed).toBe(true);
    expect(observed.deliveredInputDigest).toBe(createHash('sha256').update(callInput).digest('hex'));
    expect(observed.deliveredInputDigest).not.toBe(createHash('sha256').update(scenario.input).digest('hex'));
    expect(() => module.observeProposalExperiment({ ...prepared.experiment, callInput: check.input }, execution)).toThrow(/input delivery/i);
    expect(() => module.observeProposalExperiment(prepared.experiment, { ...execution, evidence: { ...execution.evidence,
      argv: [...execution.evidence.argv.slice(0, -1), scenario.input] } })).toThrow(/input delivery/i);
    expect(() => module.prepareProposalExperiment('tool', 'asset.js', scenario, { ...configured, input: 'Other scenario' }, inputSchema)).toThrow(/differs/);
  });

  it.each(['normal', 'refusal'] as const)('rejects any configured replacement of the %s input', async kind => {
    const module = await implementation();
    const configured = { ...experiment(), kind, callInput: check.input, assertions: [
      { id: 'exit', source: 'exit-code', expected: kind === 'normal' ? 0 : 2 }, experiment().assertions[1]] };
    expect(() => module.prepareProposalExperiment('tool', 'asset.js', { ...check, kind }, configured, inputSchema)).toThrow(/call input/i);
  });

  it('requires a control input and its tool schema and rejects invalid or absolute parameters', async () => {
    const module = await implementation();
    const scenario: ProposalCheck = { ...check, kind: 'timeout', input: 'Host deadline' };
    const configured = { ...experiment(), kind: scenario.kind, input: scenario.input, control: { kind: 'timeout', afterMs: 10 }, assertions: [
      { id: 'exit', source: 'exit-code', expected: 137 }, { id: 'host', source: 'control', path: ['kind'], expected: 'timeout' }] };
    expect(module.prepareProposalExperiment('tool', 'asset.js', scenario, configured, inputSchema)).toMatchObject({ status: 'unsupported' });
    expect(module.prepareProposalExperiment('tool', 'asset.js', scenario, { ...configured, callInput: check.input })).toMatchObject({ status: 'unsupported' });
    for (const callInput of ['invalid', '{}', '{"key":2}', '{"key":"alpha","extra":true}', '{"key":"/etc/passwd"}', '{"key":"C:\\\\secret"}', '{"key":"file:secret"}', '{"key":"alpha"}\0']) {
      expect(() => module.prepareProposalExperiment('tool', 'asset.js', scenario, { ...configured, callInput }, inputSchema), callInput).toThrow();
    }
  });

  it('compares bounded JSON values without requiring execution providers', async () => {
    const module = await implementation();
    expect(module.compareProposalActual({ first: ['value', null], second: 2 }, { second: 2, first: ['value', null] })).toBe(true);
    expect(module.compareProposalActual([1, 2], [2, 1])).toBe(false);
    expect(() => module.compareProposalActual(undefined, null)).toThrow('requires JSON');
    expect(() => module.compareProposalActual(Number.NaN, null)).toThrow('requires JSON');
    expect(() => module.compareProposalActual('value'.repeat(20000), '')).toThrow('byte limit');
    expect(() => module.compareProposalActual(Array.from({ length: 4096 }, () => null), [])).toThrow('structure limit');
  });

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
    const controlled = { ...experiment(), kind, callInput: check.input, control: { kind, afterMs: 10 }, assertions: [
      { id: 'exit', source: 'exit-code', expected: 137 }, { id: 'control', source: 'control', path: ['kind'], expected: kind }] };
    const prepared = module.prepareProposalExperiment('tool', 'asset.js', { ...check, kind }, controlled, inputSchema);
    if (prepared.status !== 'prepared') throw new Error('Missing prepared experiment');
    expect(() => module.observeProposalExperiment(prepared.experiment, result('{"cancelled":true}', 137))).toThrow(/control/i);
    const execution: FrozenExecutionResult = { ...result('', 137), evidence: { ...result().evidence, operationId: 'owned-operation', containerId: 'owned-container',
      control: { kind, afterMs: 10, outcome: 'triggered', trigger: kind === 'timeout' ? 'host-deadline' : 'host-cancellation', signal: 'SIGKILL',
        operationId: 'owned-operation', containerId: 'owned-container', exitCode: 137, runningObservedMs: 1, triggeredMs: 12, terminatedMs: 13 } } };
    expect(module.observeProposalExperiment(prepared.experiment, execution).passed).toBe(true);
    for (const change of [{ operationId: 'foreign' }, { containerId: 'foreign' }, { afterMs: 9 }, { triggeredMs: 2 }, { terminatedMs: 0 }, { triggeredMs: NaN }]) {
      expect(() => module.observeProposalExperiment(prepared.experiment, { ...execution, evidence: { ...execution.evidence,
        control: { ...execution.evidence.control!, ...change } as FrozenExecutionResult['evidence']['control'] } })).toThrow(/control/i);
    }
  });

  it.each(['cancellation', 'timeout'] as const)('records authenticated early exit as failed %s without aborting comparison', async kind => {
    const module = await implementation();
    const controlled = { ...experiment(), kind, callInput: check.input, control: { kind, afterMs: 10 }, assertions: [
      { id: 'exit', source: 'exit-code', expected: 137 }, { id: 'control', source: 'control', path: ['kind'], expected: kind }] };
    const prepared = module.prepareProposalExperiment('tool', 'asset.js', { ...check, kind }, controlled, inputSchema);
    if (prepared.status !== 'prepared') throw new Error('Missing prepared experiment');
    for (const exitCode of [0, 7, 137]) for (const runningObservedMs of [null, 1]) {
      const execution: FrozenExecutionResult = { ...result('{"cancelled":true}', exitCode), evidence: { ...result().evidence,
        operationId: 'owned-operation', containerId: 'owned-container', imageId: 'owned-image',
        policy: { ...result().evidence.policy, id: 'owned-container', operationId: 'owned-operation', imageId: 'owned-image', status: 'exited', exitCode },
        control: { kind, afterMs: 10, outcome: 'not-triggered', reason: 'early-exit', trigger: null, signal: null,
          operationId: 'owned-operation', containerId: 'owned-container', exitCode, runningObservedMs, triggeredMs: null, terminatedMs: 13 } } };
      const observed = module.observeProposalExperiment(prepared.experiment, execution);
      expect(observed.passed).toBe(false);
      expect(observed.assertions.map(assertion => assertion.actual)).toEqual([exitCode, kind]);
      for (const control of [
        { ...execution.evidence.control!, outcome: undefined }, { ...execution.evidence.control!, reason: 'unknown' },
        { ...execution.evidence.control!, trigger: 'host-cancellation' }, { ...execution.evidence.control!, signal: 'SIGKILL' },
        { ...execution.evidence.control!, triggeredMs: 12 }, { ...execution.evidence.control!, exitCode: exitCode + 1 },
        { ...execution.evidence.control!, runningObservedMs: -1 }, { ...execution.evidence.control!, runningObservedMs: 14 },
        { ...execution.evidence.control!, terminatedMs: NaN }, { ...execution.evidence.control!, containerId: 'foreign' },
      ]) expect(() => module.observeProposalExperiment(prepared.experiment, { ...execution, evidence: { ...execution.evidence,
        control: control as FrozenExecutionResult['evidence']['control'] } })).toThrow(/control/i);
      for (const drift of [{ id: 'foreign' }, { operationId: 'foreign' }, { imageId: 'foreign' }, { status: 'running' }, { exitCode: exitCode + 1 }]) {
        expect(() => module.observeProposalExperiment(prepared.experiment, { ...execution, evidence: { ...execution.evidence,
          policy: { ...execution.evidence.policy, ...drift } } })).toThrow(/control/i);
      }
    }
  });

  it('does not claim a JavaScript command interprets a skill', async () => {
    const module = await implementation();
    expect(module.prepareProposalExperiment('skill', 'SKILL.md', check, experiment())).toMatchObject({ status: 'unsupported' });
  });
});
