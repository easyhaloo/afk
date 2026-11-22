import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { FrozenExecutionResult } from '../../infrastructure/sandbox/container/frozen-execution.js';
import { buildFrozenContext, captureFrozenInput } from '../../infrastructure/sandbox/container/frozen-input.js';
import { observeProposalExperiment, prepareProposalExperiment } from './proposal-semantics.js';
import type { ProposalCheck } from './proposals.js';
import { declaredSkillReads } from './skill-trace.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const path = 'skills/parcel/SKILL.md';
const resource = { path: '/business/handoff.json', digest: sha('frozen fixture') };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(kind: ProposalCheck['kind'] = 'normal') {
  const check = { id: 'rule', kind, input: '逐袋核对原始业务单。', expected: 'candidate claim' };
  const configured = { adapter: 'skill-trace-v1', protocol: 'proposal-semantic-v1', kind, input: check.input,
    skillTrace: { checkerDigest: sha('trusted checker'), reads: kind === 'normal' ? [resource] : [] },
    assertions: [{ id: 'exit', source: 'exit-code', expected: kind === 'refusal' ? 1 : 0 }, { id: 'business', source: 'stdout', expected: 'independent result' }] };
  const prepared = prepareProposalExperiment('skill', path, check, configured);
  if (prepared.status !== 'prepared') throw new Error('Expected skill experiment');
  const { experiment } = prepared;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'trace-')));
  roots.push(root);
  mkdirSync(join(root, 'skills/parcel'), { recursive: true });
  writeFileSync(join(root, path), 'actual skill');
  const input = captureFrozenInput(root);
  const operationId = randomUUID();
  const containerId = 'registered-container';
  const options = { input, baseImageId: `sha256:${sha('base')}`, argv: experiment.argv, timeoutMs: 5000, maxOutputBytes: 4096 };
  const context = { options, operationId, containerId };
  const trace = { protocol: 'skill-trace-v1', completed: true, loaded: { path: `/workspace/${path}`, digest: sha('actual skill') },
    inputDigest: sha(check.input), outputDigest: sha('independent result'), businessValid: true,
    calls: configured.skillTrace.reads.map(result => ({ tool: 'Read', result })) };
  const execution = { exitCode: kind === 'refusal' ? 1 : 0, stdout: 'independent result', stderr: JSON.stringify(trace),
    evidence: { operationId, containerId, cwd: '/workspace', baseImageId: options.baseImageId, inputDigest: input.digest,
      contextDigest: buildFrozenContext(input, options.baseImageId, operationId).digest, mechanism: 'docker-frozen-image',
      argv: ['/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/scratch', 'TMPDIR=/scratch', ...experiment.argv] },
    cleanup: { imageRemoved: true, containerRemoved: true } } as unknown as FrozenExecutionResult;
  return { check, configured, experiment, execution, context, trace };
}

it.each(['normal', 'refusal', 'recovery'] as const)('checks observed reads and business output for %s', kind => {
  const { experiment, execution, context, trace } = fixture(kind);
  expect(observeProposalExperiment(experiment, execution, context)).toMatchObject({ passed: true, skillTrace: trace });
  expect(() => observeProposalExperiment(experiment, { ...execution, stdout: 'wrong' }, context)).toThrow();
  expect(observeProposalExperiment(experiment, { ...execution, stdout: 'wrong', stderr: JSON.stringify({ ...trace, outputDigest: sha('wrong') }) }, context).passed).toBe(false);
  expect(observeProposalExperiment(experiment, { ...execution, stderr: JSON.stringify({ ...trace, businessValid: false }) }, context).passed).toBe(false);
  const calls = kind === 'normal' ? [] : [{ tool: 'Read', result: resource }];
  expect(observeProposalExperiment(experiment, { ...execution, stderr: JSON.stringify({ ...trace, calls }) }, context).passed).toBe(false);
});

it('requires each configured or observed read in the inventory by path and digest', () => {
  const declared = { path: 'handoff.json', digest: resource.digest };
  const other = { path: '/business/other.json', digest: resource.digest };
  expect(declaredSkillReads([], undefined)).toBe(true);
  expect(declaredSkillReads([resource], [declared, { ...declared, path: 'unused.json' }])).toBe(true);
  expect(declaredSkillReads([resource])).toBe(false);
  expect(declaredSkillReads([resource], [])).toBe(false);
  expect(declaredSkillReads([resource, other], [declared])).toBe(false);
  expect(declaredSkillReads([resource], [{ ...declared, digest: sha('changed') }])).toBe(false);
});

it('rejects unbound or replayed traces, spoofed output and unknown tools', () => {
  const { experiment, execution, context, trace } = fixture();
  for (const invalid of [{ ...trace, inputDigest: sha('other input') }, { ...trace, loaded: { ...trace.loaded, digest: sha('other skill') } },
    { ...trace, loaded: { ...trace.loaded, path: '/workspace/other' } }, { ...trace, calls: [{ tool: 'Write', result: resource }] }]) {
    expect(() => observeProposalExperiment(experiment, { ...execution, stderr: JSON.stringify(invalid) }, context)).toThrow();
  }
  expect(() => observeProposalExperiment(experiment, { ...execution, stdout: execution.stderr, stderr: '' }, context)).toThrow();
  expect(() => observeProposalExperiment(experiment, execution)).toThrow();
  expect(() => observeProposalExperiment(experiment, execution, { ...context, operationId: randomUUID() })).toThrow();
  expect(() => observeProposalExperiment(experiment, execution, { ...context, containerId: 'other' })).toThrow();
});

it('requires explicit skill binding and keeps the tool adapter JSON-only', () => {
  const { check, configured } = fixture();
  const { skillTrace, ...unbound } = configured;
  expect(prepareProposalExperiment('skill', path, check, unbound).status).toBe('unsupported');
  expect(prepareProposalExperiment('tool', path, check, configured).status).toBe('unsupported');
  expect(() => prepareProposalExperiment('tool', 'parcel.js', check, { ...unbound, adapter: 'node-json-argv-v1' })).toThrow();
  expect(() => prepareProposalExperiment('skill', path, check, { ...configured, skillTrace: { ...skillTrace, reads: [] } })).toThrow();
});
