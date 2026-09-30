import type { ExecutionTimeline, WorkItemExecution, WorkItemExecutionSummary } from '@afk/application';

export function projectWorkItemExecution(timeline: ExecutionTimeline): WorkItemExecution {
  const events = timeline.events.filter(event => event.sequence <= timeline.integrity.lastSequence);
  const verifiedTimeline = { ...timeline, events };
  const first = events[0];
  const summary: WorkItemExecutionSummary = {
    executionId: first?.correlationId ?? timeline.runId,
    runId: timeline.runId,
    workItemId: first?.context.workItemId ?? '',
    status: 'unknown',
    startedAt: first?.occurredAt,
    updatedAt: events.at(-1)?.occurredAt,
  };
  if (!timeline.integrity.valid) {
    summary.diagnostic = timeline.integrity.reason ?? 'audit_error';
    return { summary, timeline: verifiedTimeline };
  }
  if (!first) {
    summary.diagnostic = 'missing_stream';
    return { summary, timeline: verifiedTimeline };
  }
  if (events.some(event => event.context.runId !== timeline.runId || event.context.workItemId !== summary.workItemId || event.correlationId !== summary.executionId || (event.data.kind === 'run.requested' && (event.data.run.id !== timeline.runId || event.data.run.workItemId !== summary.workItemId)))) {
    summary.diagnostic = 'event_identity_mismatch';
    return { summary, timeline: verifiedTimeline };
  }

  let verificationStep: string | undefined;
  let qaPassed = false;
  let publishedChangeId: string | undefined;
  summary.status = 'queued';
  for (const event of events) {
    switch (event.data.kind) {
      case 'run.started':
        summary.status = 'implementing';
        break;
      case 'implementation.completed':
        summary.status = 'verifying';
        break;
      case 'workspace.prepared':
        break;
      case 'step.started':
        if (event.data.phase === 'verification') {
          verificationStep = event.data.stepId;
          summary.status = 'verifying';
        } else if (event.data.phase === 'release') summary.status = 'publishing';
        break;
      case 'step.completed':
        if (event.data.stepId === verificationStep) {
          verificationStep = undefined;
          summary.status = event.data.outcome === 'succeeded' ? 'verifying' : 'rework';
        }
        break;
      case 'qa.started':
        summary.status = 'verifying';
        break;
      case 'qa.passed':
        qaPassed = true;
        summary.status = 'publishing';
        break;
      case 'qa.failed':
        qaPassed = false;
        summary.status = event.data.reason === 'rework' ? 'rework' : 'blocked';
        break;
      case 'change.created':
        if (event.data.url) summary.pr = { id: event.data.changeId, url: event.data.url, state: 'open' };
        summary.status = 'publishing';
        break;
      case 'change.published':
        summary.pr = { id: event.data.changeId, url: event.data.url, state: 'open' };
        if (qaPassed) publishedChangeId = event.data.changeId;
        summary.status = publishedChangeId ? 'awaiting_merge' : 'publishing';
        break;
      case 'change.merge_verified':
        if (summary.pr?.id === event.data.changeId) summary.pr = { ...summary.pr, state: 'merged' };
        if (qaPassed && publishedChangeId === event.data.changeId && typeof event.data.child === 'boolean') {
          summary.status = 'done';
        } else {
          summary.status = 'unknown';
          summary.diagnostic = !qaPassed ? 'qa_pass_not_audited' : 'child_merge_not_verified';
        }
        break;
      case 'run.finished':
        if (event.data.outcome === 'succeeded' && (summary.status === 'queued' || summary.status === 'implementing')) summary.status = 'verifying';
        else if (event.data.outcome === 'failed' && summary.status !== 'rework' && summary.status !== 'blocked' && summary.status !== 'done') summary.status = 'failed';
        else if (event.data.outcome === 'cancelled') summary.status = 'blocked';
        break;
    }
  }
  return { summary, timeline: verifiedTimeline };
}
