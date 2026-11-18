import type { CandidateStore } from './candidate-store.js';

export function completeFixtureRequest(store: CandidateStore, requestKey: string, modelOutput: unknown, callId?: string) {
  if (!callId) return store.completeRequest(requestKey, modelOutput);
  store.startAnalysisAttempt({ requestKey, callId, day: '2026-11-12', limit: 1, startedAt: '2026-11-12T00:00:00Z' });
  return store.completeAnalysisAttempt(callId, modelOutput, { finishedAt: '2026-11-12T00:00:01Z' });
}

export const request = {
  version: 1, scope: 'github:acme/api', sourceId: 'run:r1', sourceRunId: 'r1',
  workItemId: 'github:acme/api#42', evidenceDigest: 'a'.repeat(64), analyzerVersion: '1', reason: 'completed',
} as const;
export const evidence = {
  id: 'e1', kind: 'code', digest: 'b'.repeat(64), locator: 'revision:abc:rules',
  completeness: 'complete', authority: 'observed',
} as const;
export const output = { version: 1, candidates: [{
  kind: 'fact', title: 'Approval', statement: 'Approval is required', evidenceIds: ['e1'],
  applicability: { project: request.scope, environments: [], versions: ['abc'],
    preconditions: [], exclusions: [], invalidationConditions: [] },
  payload: { subject: 'approval', rule: 'Approve before publishing', classification: 'fact' },
}], warnings: [] };
