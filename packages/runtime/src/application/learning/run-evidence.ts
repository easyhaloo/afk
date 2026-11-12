import type { RunEvent } from '@afk/core';
import { parseCanonicalProject, parseWorkItemId } from '../../domain/work-item/identity.js';
import { experienceQueryContextSchema, type ExperienceQueryContext } from './experience-store.js';

export function experienceScope(workItemId: string): string {
  const identity = parseWorkItemId(workItemId);
  return `${identity.platform}:${identity.projectKey}`;
}

export function successfulRunEvidenceFromEvents(input: {
  scope: string; runId: string; evidence: readonly string[]; workItemId?: string;
}, history: readonly RunEvent[]): {
  evidence: string[]; workflowName?: string; publishedChange?: string; completionEvent: string;
  implementationCommit?: string; qaCommit?: string; changeUrl?: string; qaTarget?: ExperienceQueryContext;
} {
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
  let qaTarget: ExperienceQueryContext | undefined;
  let qaTargetTrusted = false;
  for (const event of history) {
    if (event.context.runId !== input.runId) throw new Error('Verification evidence belongs to another run');
    if (event.context.purpose === 'learning') throw new Error('Learning runs cannot verify ordinary execution experience');
    if (experienceScope(event.context.workItemId) !== input.scope) throw new Error('Verification run belongs to another project');
    if (input.workItemId !== undefined && event.context.workItemId !== input.workItemId) throw new Error('Verification run belongs to another work item');
    const data = event.data;
    const trustedActor = ['system', 'cli'].includes(event.context.actor.kind);
    if (data.kind === 'qa.started') qaTargetTrusted = trustedActor;
    if (!trustedActor && (data.kind === 'qa.passed' || data.kind === 'run.finished'
      || data.kind === 'human_gate.opened' || data.kind === 'change.merge_verified'
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
    }
    if (data.kind === 'decision.made' && data.command === 'experience.qa-target' && qaStarted && !verified) {
      qaTarget = undefined;
      if (data.accepted && data.reason && data.reason.length <= 16384 && trustedActor) {
        try { qaTarget = experienceQueryContextSchema.parse(JSON.parse(data.reason)); } catch {}
      }
    }
    if (data.kind === 'qa.passed' && qaStarted) verified = true;
    if (data.kind === 'qa.failed') { verified = completed = qaStarted = false; qaTarget = undefined; }
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
  if (!verified || !completed || failed || !completionEvent) throw new Error('Experience verification requires a successful independent QA run');
  return { evidence: [...new Set([...input.evidence, `run:${input.runId}#qa.passed`])], workflowName, publishedChange, completionEvent,
    implementationCommit, qaCommit, changeUrl, qaTarget: qaTargetTrusted ? qaTarget : undefined };
}
