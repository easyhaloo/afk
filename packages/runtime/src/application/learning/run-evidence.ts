import type { RunEvent } from '@afk/core';
import { parseCanonicalProject, parseWorkItemId } from '../../domain/work-item/identity.js';
import { verifyRunEventHistory } from '../../infrastructure/observability/jsonl-event-store.js';
import { experienceQueryContextSchema, type ExperienceAdoptionContext } from './experience-store.js';

export function experienceScope(workItemId: string): string {
  const identity = parseWorkItemId(workItemId);
  return `${identity.platform}:${identity.projectKey}`;
}

function assertEvidenceRunId(runId: string): void {
  if (typeof runId !== 'string' || !runId || runId.trim() !== runId) throw new Error('Evidence run ID must be a nonempty canonical string');
}

function verifyExecutionEvidenceHistory(input: { scope: string; runId: string; workItemId: string }, history: readonly RunEvent[]): void {
  assertEvidenceRunId(input.runId);
  const project = parseCanonicalProject(input.scope);
  if (`${project.platform}:${project.projectKey}` !== input.scope || experienceScope(input.workItemId) !== input.scope) {
    throw new Error('Evidence work item must belong to the canonical project');
  }
  if (!history.length || !verifyRunEventHistory(input.runId, history).valid) {
    throw new Error('Evidence requires a complete verified history for the selected run');
  }
  for (const event of history) {
    if (event.context.workItemId !== input.workItemId) throw new Error('Evidence belongs to another work item');
    if (event.context.purpose === 'learning') throw new Error('Learning runs cannot supply execution evidence');
  }
}

export function failedRunEvidenceFromEvents(input: {
  scope: string; runId: string; workItemId: string; evidence: readonly string[];
}, history: readonly RunEvent[]): { failureEventId: string; completionEventId: string } {
  verifyExecutionEvidenceHistory(input, history);
  let failureEventId: string | undefined;
  let completion: { failureEventId: string; completionEventId: string } | undefined;
  for (const event of history) {
    const trustedActor = ['system', 'cli'].includes(event.context.actor.kind);
    const data = event.data;
    if (trustedActor && (data.kind === 'qa.failed' || data.kind === 'failure.classified')) failureEventId = event.id;
    if (data.kind === 'run.finished') {
      completion = trustedActor && data.outcome === 'failed'
        ? { failureEventId: failureEventId ?? event.id, completionEventId: event.id } : undefined;
      failureEventId = undefined;
    }
  }
  if (!completion) throw new Error('Failure evidence requires a latest trusted failed terminal');
  return completion;
}

export function repairedRunEvidenceFromEvents(input: {
  scope: string; workItemId: string; failureRunId: string; fixRunId: string; qaRunId: string; targetRevision: string;
}, failureHistory: readonly RunEvent[], fixHistory: readonly RunEvent[]): {
  failureEventId: string; fixCommitEventId: string; fixCompletionEventId: string;
} {
  const roleIds = [input.failureRunId, input.fixRunId, input.qaRunId];
  roleIds.forEach(assertEvidenceRunId);
  if (new Set(roleIds).size !== roleIds.length) throw new Error('Failure, fix and QA run IDs must be pairwise distinct');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.targetRevision)) throw new Error('Repair target revision must be lowercase 40 or 64 character hex');
  const { failureEventId } = failedRunEvidenceFromEvents({ scope: input.scope, workItemId: input.workItemId,
    runId: input.failureRunId, evidence: [] }, failureHistory);
  verifyExecutionEvidenceHistory({ scope: input.scope, workItemId: input.workItemId, runId: input.fixRunId }, fixHistory);
  let fixCommitEventId: string | undefined;
  let fixCompletionEventId: string | undefined;
  for (const event of fixHistory) {
    const trustedActor = ['system', 'cli'].includes(event.context.actor.kind);
    const data = event.data;
    if (data.kind === 'commit.recorded' && data.phase === 'implementation') {
      fixCommitEventId = trustedActor && data.commitSha === input.targetRevision ? event.id : undefined;
      fixCompletionEventId = undefined;
    }
    if (data.kind === 'qa.failed' || data.kind === 'failure.classified') {
      fixCommitEventId = fixCompletionEventId = undefined;
    }
    if (data.kind === 'run.finished') {
      if (trustedActor && data.outcome === 'succeeded' && fixCommitEventId) fixCompletionEventId = event.id;
      else fixCommitEventId = fixCompletionEventId = undefined;
    }
  }
  if (!fixCommitEventId || !fixCompletionEventId) throw new Error('Repair evidence requires a successful repair at the exact target revision');
  return { failureEventId, fixCommitEventId, fixCompletionEventId };
}

function runEvidenceFromEvents(input: {
  scope: string; runId: string; evidence: readonly string[]; workItemId?: string;
}, history: readonly RunEvent[]) {
  parseCanonicalProject(input.scope);
  let verified = false;
  let qaStarted = false;
  let completed = false;
  let failed = false;
  let publishedChange: string | undefined;
  let workflowName: string | undefined;
  let completionEvent: string | undefined;
  let implementationCommit: string | undefined;
  let qaCommit: string | undefined;
  let changeUrl: string | undefined;
  let qaTarget: ExperienceAdoptionContext['actual'] | undefined;
  let actualTarget: ExperienceAdoptionContext['actual'] | undefined;
  let trustedTargetStarted = false;
  let qaTargetTrusted = false;
  for (const event of history) {
    if (event.context.runId !== input.runId) throw new Error('Verification evidence belongs to another run');
    if (event.context.purpose === 'learning') throw new Error('Learning runs cannot verify ordinary execution experience');
    if (experienceScope(event.context.workItemId) !== input.scope) throw new Error('Verification run belongs to another project');
    if (input.workItemId !== undefined && event.context.workItemId !== input.workItemId) throw new Error('Verification run belongs to another work item');
    const data = event.data;
    const trustedActor = ['system', 'cli'].includes(event.context.actor.kind);
    if (data.kind === 'qa.started') qaTargetTrusted = trustedActor;
    if (!trustedActor && (data.kind === 'qa.passed' || data.kind === 'qa.failed' || data.kind === 'run.finished'
      || data.kind === 'human_gate.opened' || data.kind === 'change.merge_verified' || data.kind === 'change.published'
      || (data.kind === 'decision.made' && data.command === 'experience.qa-target')
      || (data.kind === 'commit.recorded' && data.phase === 'qa'))) qaTargetTrusted = false;
    if (data.kind === 'workflow.recorded') workflowName = data.name.slice(0, 128);
    if (data.kind === 'commit.recorded') {
      const commit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(data.commitSha) ? data.commitSha.toLowerCase() : undefined;
      if (data.phase === 'implementation') implementationCommit = commit;
      else if (data.phase === 'qa') qaCommit = commit;
    }
    if (data.kind === 'qa.started') {
      qaStarted = true;
      verified = completed = false;
      publishedChange = undefined;
      changeUrl = qaCommit = undefined;
      qaTarget = undefined;
      if (trustedActor) { actualTarget = undefined; trustedTargetStarted = true; }
    }
    if (data.kind === 'decision.made' && data.command === 'experience.qa-target') {
      let recordedTarget: ExperienceAdoptionContext['actual'] | undefined;
      if (data.accepted && data.reason && data.reason.length <= 16384 && trustedActor) {
        try { recordedTarget = experienceQueryContextSchema.parse(JSON.parse(data.reason)); } catch {}
      }
      if (trustedActor && trustedTargetStarted) actualTarget = recordedTarget;
      if (qaStarted && !verified) qaTarget = recordedTarget;
      else if (trustedActor) qaTargetTrusted = false;
    }
    if (data.kind === 'qa.passed' && qaStarted) verified = true;
    if (data.kind === 'qa.failed') {
      verified = completed = qaStarted = false;
      qaTarget = undefined;
      if (trustedActor) { actualTarget = undefined; trustedTargetStarted = false; }
    }
    if (data.kind === 'change.published' && verified) {
      publishedChange = data.changeId;
      changeUrl = undefined;
      if (Buffer.byteLength(data.url) <= 200 && !/[\s\0]/.test(data.url)) {
        try {
          const url = new URL(data.url);
          if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) changeUrl = data.url;
        } catch {}
      }
    }
    if (verified && publishedChange && (
      (data.kind === 'human_gate.opened' && data.gateId === `merge:${publishedChange}`)
      || (data.kind === 'change.merge_verified' && data.changeId === publishedChange)
    )) { completed = true; completionEvent = data.kind; }
    if (data.kind === 'run.finished') {
      if (data.outcome !== 'succeeded') failed = true;
      else if (verified) { completed = true; completionEvent = data.kind; }
    }
  }
  return { verified, completed, failed, evidence: [...new Set([...input.evidence, `run:${input.runId}#qa.passed`])], workflowName, publishedChange, completionEvent,
    implementationCommit, qaCommit, changeUrl, actualTarget, qaTarget: qaTargetTrusted ? qaTarget : undefined };
}

export function successfulRunEvidenceFromEvents(input: Parameters<typeof runEvidenceFromEvents>[0], history: readonly RunEvent[]) {
  const { verified, completed, failed, actualTarget: _actualTarget, ...audit } = runEvidenceFromEvents(input, history);
  if (!verified || !completed || failed || !audit.completionEvent) throw new Error('Experience verification requires a successful independent QA run');
  return { ...audit, completionEvent: audit.completionEvent };
}

export function adoptionRunContextFromEvents(input: Parameters<typeof runEvidenceFromEvents>[0], history: readonly RunEvent[]): ExperienceAdoptionContext {
  const audit = runEvidenceFromEvents(input, history);
  const actual = audit.actualTarget ?? {};
  const target = actual.target;
  const qualified = audit.qaTarget && audit.verified && audit.completed && !audit.failed && audit.completionEvent
    && target?.revision && target.dirty === false && target.project === input.scope && target.revision === audit.qaCommit;
  return { actual, ...(qualified ? { verified: actual } : {}) };
}
