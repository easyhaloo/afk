import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunEvent, RunEventData, RunEventDraft } from '@afk/core';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import * as runEvidence from './run-evidence.js';
import { adoptionRunContextFromEvents, experienceScope, successfulRunEvidenceFromEvents } from './run-evidence.js';

const scope = 'github:acme/wiki';
const input = { scope, runId: 'independent-qa', workItemId: `${scope}#42`, evidence: [] };
const history = (data: RunEventData[]): RunEvent[] => data.map((entry, index) => ({
  id: `event-${index}`, schemaVersion: 1, type: entry.kind, sequence: index + 1,
  occurredAt: '2026-11-12T00:00:00.000Z', observedAt: '2026-11-12T00:00:00.000Z',
  context: { traceId: input.runId, runId: input.runId, workItemId: input.workItemId,
    profileId: 'fixture', attempt: 1, actor: { kind: 'system', id: 'runtime' } },
  correlationId: input.runId, data: entry, integrity: { hash: 'a'.repeat(64) },
}));
const successful = () => history([{ kind: 'qa.started' }, { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' }]);

const evidenceRoots: string[] = [];
afterEach(async () => {
  await Promise.all(evidenceRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function signedHistory(runId: string, data: RunEventData[], context: Partial<RunEvent['context']> = {},
  configure?: (draft: RunEventDraft, index: number) => void): Promise<RunEvent[]> {
  const root = await mkdtemp(join(tmpdir(), 'afk-run-evidence-'));
  evidenceRoots.push(root);
  const store = new JsonlEventStore({ root });
  const drafts: RunEventDraft[] = data.map((entry, index) => ({
    id: `${runId}-${index}`, schemaVersion: 1, type: entry.kind,
    occurredAt: '2026-11-18T00:00:00.000Z', correlationId: runId, data: entry,
    context: { traceId: runId, runId, workItemId: input.workItemId, profileId: 'fixture', attempt: 1,
      actor: { kind: 'system', id: 'runtime' }, ...context },
  }));
  drafts.forEach((draft, index) => configure?.(draft, index));
  if (drafts.length) await store.append(drafts);
  const events: RunEvent[] = [];
  for await (const event of store.read(runId)) events.push(event);
  return events;
}

const failureInput = { ...input, runId: 'failure-run' };
const repairInput = { scope, workItemId: input.workItemId, failureRunId: failureInput.runId,
  fixRunId: 'fix-run', qaRunId: input.runId, targetRevision: 'a'.repeat(40) };
const failureData: RunEventData[] = [
  { kind: 'failure.classified', failureClass: 'qa', summary: 'acceptance failed' },
  { kind: 'qa.failed', reason: 'acceptance failed' }, { kind: 'run.finished', outcome: 'failed' },
];
const fixCommit = (commitSha = repairInput.targetRevision): RunEventData =>
  ({ kind: 'commit.recorded', phase: 'implementation', commitSha, branch: 'fix' });
const fixData = (): RunEventData[] => [fixCommit(), { kind: 'run.finished', outcome: 'succeeded' }];
const untrustedActors = ['agent', 'human', 'loop', 'policy'] as const;
const corruptions: Array<[string, (events: RunEvent[]) => RunEvent[]]> = [
  ['empty', () => []],
  ['tampered payload', events => { events[0].data = { kind: 'qa.passed' }; return events; }],
  ['tampered hash', events => { events[0].integrity.hash = '0'.repeat(64); return events; }],
  ['missing prefix', events => events.slice(1)],
  ['sequence gap', events => { events[0].sequence = 2; return events; }],
  ['broken previous hash', events => { events[1].integrity.prevHash = '0'.repeat(64); return events; }],
  ['wrong run', events => { events[0].context.runId = 'other-run'; return events; }],
];

describe('failed run evidence', () => {
  it.each(['system', 'cli'] as const)('selects trusted failure and terminal event IDs for %s', async actor => {
    const events = await signedHistory(failureInput.runId, failureData, { actor: { kind: actor, id: 'runtime' } });
    expect(runEvidence.failedRunEvidenceFromEvents(failureInput, events)).toEqual({
      failureEventId: events[1].id, completionEventId: events[2].id,
    });
  });

  it.each([
    { preceding: [{ kind: 'failure.classified', failureClass: 'execution', summary: 'failed' }] }, { preceding: [] },
  ] satisfies Array<{ preceding: RunEventData[] }>)('accepts classified failure or the failed terminal itself: %j', async ({ preceding }) => {
    const events = await signedHistory(failureInput.runId, [...preceding, { kind: 'run.finished', outcome: 'failed' }]);
    expect(runEvidence.failedRunEvidenceFromEvents(failureInput, events)).toEqual({
      failureEventId: events[0].id, completionEventId: events.at(-1)!.id,
    });
  });

  it('ignores untrusted failure claims and failures recorded after completion', async () => {
    const events = await signedHistory(failureInput.runId, [...failureData,
      { kind: 'qa.failed', reason: 'late claim' }], {}, (draft, index) => {
      if (index === 1) draft.context.actor = { kind: 'agent', id: 'claim' };
    });
    expect(runEvidence.failedRunEvidenceFromEvents(failureInput, events)).toEqual({
      failureEventId: events[0].id, completionEventId: events[2].id,
    });
  });

  it.each(['succeeded', 'cancelled'] as const)('rejects a later %s terminal', async outcome => {
    const events = await signedHistory(failureInput.runId, [...failureData, { kind: 'run.finished', outcome }]);
    expect(() => runEvidence.failedRunEvidenceFromEvents(failureInput, events)).toThrow(/trusted failed terminal/);
  });

  it('requires a terminal even with trusted failure evidence', async () => {
    const events = await signedHistory(failureInput.runId, failureData.slice(0, -1));
    expect(() => runEvidence.failedRunEvidenceFromEvents(failureInput, events)).toThrow(/trusted failed terminal/);
  });

  it.each(untrustedActors)('rejects the latest terminal authored by %s', async actor => {
    const events = await signedHistory(failureInput.runId, [...failureData, { kind: 'run.finished', outcome: 'failed' }],
      {}, (draft, index) => { if (index === 3) draft.context.actor = { kind: actor, id: 'claim' }; });
    expect(() => runEvidence.failedRunEvidenceFromEvents(failureInput, events)).toThrow(/trusted failed terminal/);
  });

  it.each(corruptions)('rejects %s histories', async (_name, corrupt) => {
    const events = corrupt(await signedHistory(failureInput.runId, failureData));
    expect(() => runEvidence.failedRunEvidenceFromEvents(failureInput, events)).toThrow(/complete verified history/);
  });

  it.each([
    ['other work item', `${scope}#43`], ['other project', 'github:acme/other#42'],
    ['noncanonical work item', `${scope}#042`],
  ])('rejects a signed event for %s', async (_name, workItemId) => {
    const events = await signedHistory(failureInput.runId, failureData, {}, (draft, index) => {
      if (index === 1) draft.context.workItemId = workItemId;
    });
    expect(() => runEvidence.failedRunEvidenceFromEvents(failureInput, events)).toThrow(/work item/);
  });

  it.each([
    { ...failureInput, scope: 'acme/wiki' }, { ...failureInput, scope: 'github:acme/other' },
    { ...failureInput, workItemId: `${scope}#042` }, { ...failureInput, runId: '' },
    { ...failureInput, runId: ' failure-run' },
  ])('rejects invalid input %j', async invalid => {
    const events = await signedHistory(failureInput.runId, failureData);
    expect(() => runEvidence.failedRunEvidenceFromEvents(invalid, events)).toThrow(/canonical|project|work item|run ID/);
  });

  it('rejects learning purpose anywhere in a signed chain', async () => {
    const events = await signedHistory(failureInput.runId, failureData, {}, (draft, index) => {
      if (index === 1) draft.context.purpose = 'learning';
    });
    expect(() => runEvidence.failedRunEvidenceFromEvents(failureInput, events)).toThrow(/Learning runs/);
  });
});

describe('repaired run evidence', () => {
  it.each([40, 64])('binds distinct runs and exact %i-character revision without inferring prose causality', async length => {
    const targetRevision = 'a'.repeat(length);
    const failure = await signedHistory(repairInput.failureRunId, failureData);
    const fix = await signedHistory(repairInput.fixRunId, [fixCommit(targetRevision), ...fixData().slice(1)],
      { actor: { kind: 'cli', id: 'runtime' } });
    expect(runEvidence.repairedRunEvidenceFromEvents({ ...repairInput, targetRevision }, failure, fix)).toEqual({
      failureEventId: failure[1].id, fixCommitEventId: fix[0].id, fixCompletionEventId: fix[1].id,
    });
  });

  it.each([
    { failureRunId: repairInput.fixRunId }, { qaRunId: repairInput.failureRunId }, { qaRunId: repairInput.fixRunId },
  ])('rejects colliding role IDs %j', async roles => {
    const failure = await signedHistory(repairInput.failureRunId, failureData);
    const fix = await signedHistory(repairInput.fixRunId, fixData());
    expect(() => runEvidence.repairedRunEvidenceFromEvents({ ...repairInput, ...roles }, failure, fix)).toThrow(/distinct/);
  });

  it.each(['failureRunId', 'fixRunId', 'qaRunId'] as const)('rejects an empty %s', async role => {
    const failure = await signedHistory(repairInput.failureRunId, failureData);
    const fix = await signedHistory(repairInput.fixRunId, fixData());
    expect(() => runEvidence.repairedRunEvidenceFromEvents({ ...repairInput, [role]: '' }, failure, fix)).toThrow(/run ID/);
  });

  it('rejects swapped history arguments and swapped configured failure/fix roles', async () => {
    const failure = await signedHistory(repairInput.failureRunId, failureData);
    const fix = await signedHistory(repairInput.fixRunId, fixData());
    expect(() => runEvidence.repairedRunEvidenceFromEvents(repairInput, fix, failure)).toThrow(/complete verified history/);
    expect(() => runEvidence.repairedRunEvidenceFromEvents({ ...repairInput,
      failureRunId: repairInput.fixRunId, fixRunId: repairInput.failureRunId }, fix, failure)).toThrow(/trusted failed terminal/);
  });

  it.each(['failure', 'fix'] as const)('rejects a signed wrong work item in %s history', async role => {
    const failure = await signedHistory(repairInput.failureRunId, failureData,
      role === 'failure' ? { workItemId: `${scope}#43` } : {});
    const fix = await signedHistory(repairInput.fixRunId, fixData(), {}, (draft, index) => {
      if (role === 'fix' && index === 1) draft.context.workItemId = `${scope}#43`;
    });
    expect(() => runEvidence.repairedRunEvidenceFromEvents(repairInput, failure, fix)).toThrow(/work item/);
  });

  it.each(['failure', 'fix'] as const)('rejects learning purpose in %s history', async role => {
    const failure = await signedHistory(repairInput.failureRunId, failureData,
      role === 'failure' ? { purpose: 'learning' } : {});
    const fix = await signedHistory(repairInput.fixRunId, fixData(), role === 'fix' ? { purpose: 'learning' } : {});
    expect(() => runEvidence.repairedRunEvidenceFromEvents(repairInput, failure, fix)).toThrow(/Learning runs/);
  });

  it.each(corruptions)('rejects %s fix history', async (_name, corrupt) => {
    const failure = await signedHistory(repairInput.failureRunId, failureData);
    const fix = corrupt(await signedHistory(repairInput.fixRunId, fixData()));
    expect(() => runEvidence.repairedRunEvidenceFromEvents(repairInput, failure, fix)).toThrow(/complete verified history/);
  });

  it.each(corruptions)('rejects %s failure history', async (_name, corrupt) => {
    const failure = corrupt(await signedHistory(repairInput.failureRunId, failureData));
    const fix = await signedHistory(repairInput.fixRunId, fixData());
    expect(() => runEvidence.repairedRunEvidenceFromEvents(repairInput, failure, fix)).toThrow(/complete verified history/);
  });

  it.each(['b'.repeat(40), 'A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), 'g'.repeat(64)])(
    'rejects wrong or noncanonical implementation revision %s', async revision => {
      const failure = await signedHistory(repairInput.failureRunId, failureData);
      const fix = await signedHistory(repairInput.fixRunId, [fixCommit(revision), ...fixData().slice(1)]);
      expect(() => runEvidence.repairedRunEvidenceFromEvents(repairInput, failure, fix)).toThrow(/successful repair/);
    });

  it.each(['A'.repeat(40), 'a'.repeat(39), 'a'.repeat(65), 'g'.repeat(40), ' a'.repeat(20),
    `${'a'.repeat(40)}\n`, `${'a'.repeat(64)}\r\n`])(
    'rejects invalid target revision %s', async targetRevision => {
      const failure = await signedHistory(repairInput.failureRunId, failureData);
      const fix = await signedHistory(repairInput.fixRunId, fixData());
      expect(() => runEvidence.repairedRunEvidenceFromEvents({ ...repairInput, targetRevision }, failure, fix)).toThrow(/target revision/);
    });

  it.each(untrustedActors)('rejects implementation or completion authority from %s', async actor => {
    const failure = await signedHistory(repairInput.failureRunId, failureData);
    for (const eventIndex of [0, 1]) {
      const fix = await signedHistory(repairInput.fixRunId, fixData(), {}, (draft, index) => {
        if (index === eventIndex) draft.context.actor = { kind: actor, id: 'claim' };
      });
      expect(() => runEvidence.repairedRunEvidenceFromEvents(repairInput, failure, fix)).toThrow(/successful repair/);
    }
  });

  it.each([
    ['no commit', [{ kind: 'run.finished', outcome: 'succeeded' }]],
    ['no completion', [fixCommit()]],
    ['completion before commit', [{ kind: 'run.finished', outcome: 'succeeded' }, fixCommit()]],
    ['QA commit only', [{ kind: 'commit.recorded', phase: 'qa', commitSha: repairInput.targetRevision, branch: 'qa' },
      { kind: 'run.finished', outcome: 'succeeded' }]],
    ['later wrong commit', [...fixData(), fixCommit('b'.repeat(40)), { kind: 'run.finished', outcome: 'succeeded' }]],
    ['later failed terminal', [...fixData(), { kind: 'run.finished', outcome: 'failed' }]],
    ['later cancelled terminal', [...fixData(), { kind: 'run.finished', outcome: 'cancelled' }]],
    ['QA failure before completion', [fixCommit(), { kind: 'qa.failed', reason: 'failed' }, { kind: 'run.finished', outcome: 'succeeded' }]],
    ['QA failure after completion', [...fixData(), { kind: 'qa.failed', reason: 'failed' }]],
    ['classified failure then success', [fixCommit(), { kind: 'failure.classified', failureClass: 'qa', summary: 'failed' },
      { kind: 'run.finished', outcome: 'succeeded' }]],
    ['failed terminal then success', [fixCommit(), { kind: 'run.finished', outcome: 'failed' }, { kind: 'run.finished', outcome: 'succeeded' }]],
    ['new matching commit without completion', [...fixData(), fixCommit()]],
  ] satisfies Array<[string, RunEventData[]]>)('rejects %s', async (_name, data) => {
    const failure = await signedHistory(repairInput.failureRunId, failureData);
    const fix = await signedHistory(repairInput.fixRunId, data);
    expect(() => runEvidence.repairedRunEvidenceFromEvents(repairInput, failure, fix)).toThrow(/successful repair/);
  });

  it.each([
    { kind: 'qa.failed', reason: 'failed' },
    { kind: 'failure.classified', failureClass: 'qa', summary: 'failed' },
    { kind: 'run.finished', outcome: 'failed' },
    fixCommit('b'.repeat(40)),
  ] satisfies RunEventData[])('accepts a fresh matching commit and terminal after %j', async failureEvent => {
    const failure = await signedHistory(repairInput.failureRunId, failureData);
    const fix = await signedHistory(repairInput.fixRunId, [...fixData(), failureEvent, ...fixData()]);
    expect(runEvidence.repairedRunEvidenceFromEvents(repairInput, failure, fix)).toEqual({
      failureEventId: failure[1].id, fixCommitEventId: fix[3].id, fixCompletionEventId: fix[4].id,
    });
  });

  it('does not let untrusted late authority preserve an earlier successful fix', async () => {
    const failure = await signedHistory(repairInput.failureRunId, failureData);
    for (const late of [fixCommit(), { kind: 'run.finished', outcome: 'succeeded' },
      { kind: 'qa.failed', reason: 'regression' }] satisfies RunEventData[]) {
      const fix = await signedHistory(repairInput.fixRunId, [...fixData(), late], {}, (draft, index) => {
        if (index === 2) draft.context.actor = { kind: 'agent', id: 'claim' };
      });
      expect(() => runEvidence.repairedRunEvidenceFromEvents(repairInput, failure, fix)).toThrow(/successful repair/);
    }
  });

  it('rejects a source failure run that later succeeded', async () => {
    const failure = await signedHistory(repairInput.failureRunId, [...failureData, { kind: 'run.finished', outcome: 'succeeded' }]);
    const fix = await signedHistory(repairInput.fixRunId, fixData());
    expect(() => runEvidence.repairedRunEvidenceFromEvents(repairInput, failure, fix)).toThrow(/trusted failed terminal/);
  });
});

describe('shared QA event evidence', () => {
  it('retains trusted actual context while untrusted lifecycle events revoke QA qualification', () => {
    const actual = { target: { project: scope, revision: 'a'.repeat(40), dirty: false, productVersions: { sqlite: '3.45' } } };
    const active: RunEventData[] = [{ kind: 'qa.started' },
      { kind: 'decision.made', command: 'experience.qa-target', accepted: true, reason: JSON.stringify(actual) }];
    const qualified: RunEventData[] = [...active,
      { kind: 'commit.recorded', phase: 'qa', commitSha: actual.target.revision, branch: 'qa' },
      { kind: 'qa.passed' }, { kind: 'change.published', changeId: '5', url: 'https://example.test/pr/5' },
      { kind: 'human_gate.opened', gateId: 'merge:5', reason: 'awaiting human merge' }];
    expect(adoptionRunContextFromEvents(input, history(qualified))).toEqual({ actual, verified: actual });
    const untrusted: RunEventData[] = [
      { kind: 'qa.started' }, { kind: 'qa.passed' }, { kind: 'qa.failed', reason: 'agent assertion' },
      { kind: 'run.finished', outcome: 'succeeded' },
      { kind: 'commit.recorded', phase: 'qa', commitSha: actual.target.revision, branch: 'qa' },
      { kind: 'human_gate.opened', gateId: 'merge:5', reason: 'agent assertion' },
      { kind: 'change.merge_verified', changeId: '5', targetBranch: 'main' },
      { kind: 'change.published', changeId: '5', url: 'https://example.test/pr/5' },
      { kind: 'decision.made', command: 'experience.qa-target', accepted: true,
        reason: JSON.stringify({ target: { ...actual.target, revision: 'b'.repeat(40) } }) },
    ];
    for (const preceding of [active, qualified]) {
      for (const data of untrusted) {
        const events = history([...preceding, data]);
        events.at(-1)!.context.actor = { kind: 'agent', id: 'untrusted' };
        expect(adoptionRunContextFromEvents(input, events), `${preceding.length}:${data.kind}`).toEqual({ actual });
      }
    }
    const changed = { target: { ...actual.target, revision: 'b'.repeat(40) } };
    for (const completion of [
      { kind: 'qa.passed' }, { kind: 'qa.failed', reason: 'agent assertion' }, { kind: 'run.finished', outcome: 'succeeded' },
    ] satisfies RunEventData[]) {
      const events = history([...active, completion,
        { kind: 'decision.made', command: 'experience.qa-target', accepted: true, reason: JSON.stringify(changed) }]);
      events[active.length].context.actor = { kind: 'agent', id: 'untrusted' };
      expect(adoptionRunContextFromEvents(input, events), completion.kind).toEqual({ actual: changed });
    }
    expect(adoptionRunContextFromEvents(input, history([...qualified,
      { kind: 'decision.made', command: 'experience.qa-target', accepted: true, reason: JSON.stringify(changed) }]))).toEqual({ actual: changed });
  });

  it('separates recorded context from successful exact-revision QA qualification across lifecycle changes', () => {
    const actual = { target: { project: scope, revision: 'a'.repeat(40), dirty: false } };
    const snapshot: RunEventData = { kind: 'decision.made', command: 'experience.qa-target', accepted: true, reason: JSON.stringify(actual) };
    const active: RunEventData[] = [{ kind: 'qa.started' }, snapshot];
    const qualified: RunEventData[] = [...active, { kind: 'commit.recorded', phase: 'qa', commitSha: actual.target.revision, branch: 'qa' },
      { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' }];
    expect(adoptionRunContextFromEvents(input, history(active))).toEqual({ actual });
    expect(adoptionRunContextFromEvents(input, history([...active, { kind: 'qa.passed' }]))).toEqual({ actual });
    expect(adoptionRunContextFromEvents(input, history(qualified))).toEqual({ actual, verified: actual });
    expect(adoptionRunContextFromEvents(input, history([...qualified, { kind: 'qa.started' }]))).toEqual({ actual: {} });
    expect(adoptionRunContextFromEvents(input, history([...active, { kind: 'qa.failed' }]))).toEqual({ actual: {} });
    expect(adoptionRunContextFromEvents(input, history([...active, { kind: 'run.finished', outcome: 'failed' }]))).toEqual({ actual });
    expect(adoptionRunContextFromEvents(input, history(qualified.map(data => data.kind === 'commit.recorded'
      ? { ...data, commitSha: 'b'.repeat(40) } : data)))).toEqual({ actual });
    for (const eventIndex of [0, 1]) {
      expect(adoptionRunContextFromEvents(input, history(active).map((event, index) => index === eventIndex
        ? { ...event, context: { ...event.context, actor: { kind: 'agent', id: 'claim' } } } : event))).toEqual({ actual: {} });
    }
    expect(() => adoptionRunContextFromEvents(input, history(active).map(event => ({ ...event,
      context: { ...event.context, purpose: 'learning' } })))).toThrow('Learning runs');
  });

  it('derives project scope and requires a completed independent QA history', () => {
    expect(experienceScope(input.workItemId)).toBe(scope);
    expect(successfulRunEvidenceFromEvents(input, successful())).toMatchObject({
      evidence: ['run:independent-qa#qa.passed'], completionEvent: 'run.finished',
    });
    expect(() => successfulRunEvidenceFromEvents(input, history([{ kind: 'qa.passed' },
      { kind: 'run.finished', outcome: 'succeeded' }]))).toThrow(/successful independent QA/);
  });

  it('rejects other work items, analysis runs and a new unfinished QA cycle', () => {
    expect(() => successfulRunEvidenceFromEvents({ ...input, workItemId: `${scope}#43` }, successful())).toThrow(/another work item/);
    expect(() => successfulRunEvidenceFromEvents(input, successful().map(event => ({ ...event,
      context: { ...event.context, purpose: 'learning' } })))).toThrow(/Learning runs/);
    expect(() => successfulRunEvidenceFromEvents(input, history([{ kind: 'qa.started' }, { kind: 'qa.passed' },
      { kind: 'run.finished', outcome: 'succeeded' }, { kind: 'qa.started' }]))).toThrow(/successful independent QA/);
  });
});
