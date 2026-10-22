import { stripVTControlCharacters } from 'node:util';
import chalk from 'chalk';
import type { ObserveRunResult, QueryExecutionHistoryResult } from '@afk/application';
import type { RunEvent, RunEventData } from '@afk/core';

const titles: Record<RunEventData['kind'], string> = {
  'run.requested': 'Run requested',
  'run.started': 'Run started',
  'lease.granted': 'Lease granted',
  'workspace.prepared': 'Workspace prepared',
  'workflow.recorded': 'Workflow recorded',
  'change.created': 'Change created',
  'change.merge_verified': 'Change merge verified',
  'qa.started': 'QA started',
  'commit.recorded': 'Commit recorded',
  'implementation.completed': 'Implementation completed',
  'qa.passed': 'QA passed',
  'qa.failed': 'QA failed',
  'change.published': 'Change published',
  'decision.made': 'Decision made',
  'effect.started': 'Effect started',
  'effect.completed': 'Effect completed',
  'step.started': 'Step started',
  'step.completed': 'Step completed',
  'human_gate.opened': 'Awaiting human review',
  'human_gate.approved': 'Human review approved',
  'run.finished': 'Run finished',
  'failure.classified': 'Failure classified',
  'agent.session_recorded': 'Agent session recorded',
};

function text(value: unknown): string {
  return stripVTControlCharacters(String(value)).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

function label(key: string): string {
  const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function fields(value: Record<string, unknown>, indent = '                 '): string[] {
  return Object.entries(value).flatMap(([key, entry]) => {
    if (entry === undefined) return [];
    const heading = `${indent}${label(key)}`;
    if (Array.isArray(entry)) {
      return [heading, ...(entry.length ? entry.flatMap(item =>
        item !== null && typeof item === 'object'
          ? [`${indent}  -`, ...fields(item, `${indent}    `)]
          : [`${indent}  - ${text(item)}`]) : [`${indent}  (none)`])];
    }
    if (entry !== null && typeof entry === 'object') return [heading, ...fields(entry as Record<string, unknown>, `${indent}  `)];
    const lines = text(entry).split('\n');
    return [`${heading}: ${lines[0]}`, ...lines.slice(1).map(line => `${indent}  ${line}`)];
  });
}

function level(data: RunEventData): 'INFO' | 'OK' | 'ERROR' | 'WARN' | 'WAIT' {
  if (data.kind === 'failure.classified' || data.kind === 'qa.failed' || ('outcome' in data && data.outcome === 'failed')) return 'ERROR';
  if ((data.kind === 'run.finished' && data.outcome === 'cancelled') || (data.kind === 'decision.made' && !data.accepted)) return 'WARN';
  if (data.kind === 'human_gate.opened') return 'WAIT';
  if (data.kind.endsWith('.completed') || data.kind === 'qa.passed' || data.kind === 'human_gate.approved' || data.kind === 'change.merge_verified' || data.kind === 'run.finished') return 'OK';
  return 'INFO';
}

function colored(value: string, severity: ReturnType<typeof level>): string {
  if (!process.stdout.isTTY || process.env.NO_COLOR !== undefined) return value;
  if (severity === 'ERROR') return chalk.red(value);
  if (severity === 'WARN' || severity === 'WAIT') return chalk.yellow(value);
  if (severity === 'OK') return chalk.green(value);
  return chalk.cyan(value);
}

function timestamp(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('sv-SE', { hour12: false }) : text(value);
}

export function formatEvent(event: RunEvent): string {
  const { kind, ...details } = event.data;
  const severity = level(event.data);
  const lines = [`${timestamp(event.occurredAt)}  ${colored(severity.padEnd(5), severity)} #${event.sequence} ${titles[kind]}`];
  if (kind !== 'run.requested') lines.push(...fields(details));
  if (severity === 'ERROR' && !('reason' in details && details.reason) && !('summary' in details && details.summary) && !('failedCriteria' in details && details.failedCriteria?.length)) {
    lines.push('                 No detailed failure reason recorded');
  }
  if (event.evidence?.length) lines.push(...fields({ evidence: event.evidence }));
  return lines.join('\n');
}

export function formatIntegrity(integrity: ObserveRunResult['integrity']): string {
  return integrity.valid
    ? `Integrity  VALID · ${integrity.lastSequence} events`
    : `Integrity  INVALID · verified through #${integrity.lastSequence}\nReason     ${text(integrity.reason ?? 'unknown error')}\nState is untrusted; only verified event details are shown.`;
}

export function formatRunStatus(observed: ObserveRunResult): string {
  if (!observed.integrity.valid) return 'State      UNKNOWN (invalid audit stream)';
  if (!observed.state.run) return 'State      UNKNOWN (no events recorded)';
  const { state } = observed;
  return [
    `State      ${state.run!.status.toUpperCase()}    Phase  ${text(state.run!.phase ?? 'not recorded')}`,
    `Active     ${text(state.activeStep ?? 'No active step recorded')}`,
    ...(state.humanGateId ? [`Waiting    Human gate ${text(state.humanGateId)}`] : []),
  ].join('\n');
}

export function formatRun(observed: ObserveRunResult, tail?: number): string {
  const events = observed.events.filter(event => event.sequence <= observed.integrity.lastSequence);
  const selected = tail === undefined ? events : tail === 0 ? [] : events.slice(-tail);
  const run = observed.integrity.valid ? observed.state.run : undefined;
  const workspace = [...events].reverse().find(event => event.data.kind === 'workspace.prepared')?.data;
  const first = events.find(event => event.data.kind === 'run.started') ?? events[0];
  const last = events.at(-1);
  const elapsedMs = first ? Math.max(0, (observed.state.terminal && last ? Date.parse(last.occurredAt) : Date.now()) - Date.parse(first.occurredAt)) : 0;
  const seconds = Math.floor(elapsedMs / 1000);
  const duration = `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m ${seconds % 60}s`;
  return [
    `Run        ${text(observed.runId)}`,
    ...(run ? [`Work item  ${text(run.workItemId)}    Attempt  ${run.attempt}    Profile  ${text(run.profileId)}`] : []),
    formatRunStatus(observed),
    formatIntegrity(observed.integrity),
    `Time zone  ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    ...(first ? [`Started    ${timestamp(first.occurredAt)}    Elapsed  ${duration}`] : []),
    ...(workspace?.kind === 'workspace.prepared' ? [`Workspace  ${text(workspace.workspace)}`, `Branch     ${text(workspace.branch)}    Base  ${text(workspace.baseBranch)}`] : []),
    ...(last ? [`Latest     #${last.sequence} ${titles[last.data.kind]} at ${timestamp(last.occurredAt)}`] : []),
    '',
    `Timeline   Showing ${selected.length} of ${events.length} events`,
    ...(events.length ? selected.map(formatEvent) : ['No events recorded for this run.']),
  ].join('\n');
}

export function formatExecutionHistory(page: QueryExecutionHistoryResult): string {
  if (!page.executions.length) return 'No executions recorded.';
  return [
    'RUN  |  WORK ITEM  |  STATE  |  PHASE  |  ATTEMPT  |  EVENTS',
    ...page.executions.map(run => `${text(run.runId)}  |  ${text(run.workItemId)}  |  ${run.status.toUpperCase()}  |  ${text(run.phase ?? '-')}  |  ${run.attempt}  |  ${run.sequence}`),
    ...(page.nextCursor ? [`\nNext page: --since ${text(page.nextCursor)}`] : []),
  ].join('\n');
}
