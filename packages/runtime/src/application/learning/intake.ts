import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { RunEvent } from '@afk/core';
import { z } from 'zod';
import { JsonlEventStore, verifyRunEventHistory } from '../../infrastructure/observability/jsonl-event-store.js';
import { CandidateStore, type StoredDistillationRequest } from './candidate-store.js';
import { learningScopeSchema } from './contracts.js';
import { buildEvidencePack, readEvidenceSource, redactEvidenceText, type EvidencePack, type EvidenceSourceInput } from './evidence.js';
import { canonicalLearningJson, learningIdentitySchema } from './requests.js';
import { experienceScope, successfulRunEvidenceFromEvents } from './run-evidence.js';
import { submitDistillation } from './worker.js';

export interface ReconcileDistillationOptions {
  directory: string;
  eventRoot?: string;
  homeDir?: string;
  scope?: string;
  runId?: string;
  analyzerVersion?: string;
}

export interface DistillationReconciliation {
  scanned: number;
  submitted: number;
  invalidated: number;
  checkedSources: Array<{ runId: string; eventRoot: string }>;
  blocked: Array<{ runId: string; code: string; eventRoot?: string }>;
}

const intakeCodes = new Set(['audit_invalid', 'audit_changed', 'audit_unstable', 'source_not_allowed', 'source_limit', 'evidence_unavailable', 'storage_blocked']);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function contains(root: string, path: string): boolean {
  const suffix = relative(resolve(root), resolve(path));
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function withdraw(store: CandidateStore, requests: readonly StoredDistillationRequest[]): number {
  let invalidated = 0;
  for (const entry of requests) {
    if (store.invalidateRequestSource(entry.key)) invalidated += 1;
  }
  return invalidated;
}

export async function reconcileDistillationSources(input: ReconcileDistillationOptions): Promise<DistillationReconciliation> {
  const scopeFilter = input.scope === undefined ? undefined : learningScopeSchema.parse(input.scope);
  const runFilter = input.runId === undefined ? undefined : learningIdentitySchema.parse(input.runId);
  const analyzerVersion = learningIdentitySchema.parse(input.analyzerVersion ?? '1');
  const home = await fs.realpath(input.homeDir ?? homedir());
  const defaultRoot = resolve(input.eventRoot ?? process.env.AFK_EVENT_STORE_DIR ?? join(home, '.afk', 'events'));
  const allowedRoots = [join(home, '.afk', 'transcripts'), join(home, '.claude', 'projects'),
    join(home, '.codex', 'sessions'), join(home, '.codex', 'archived_sessions')];
  const result: DistillationReconciliation = { scanned: 0, submitted: 0, invalidated: 0, checkedSources: [], blocked: [] };
  const store = new CandidateStore({ file: join(input.directory, 'candidates.sqlite') });
  try {
    const knownSources = [...store.listScanSources().map(source => ({ runId: source.runId, root: source.sourceRoot, scope: source.scope })), ...store.listRequests().flatMap(entry => {
      if (!entry.request.sourceRunId) return [];
      const identity = { scope: entry.request.scope, runId: entry.request.sourceRunId, analyzerVersion: entry.request.analyzerVersion };
      return store.getScanCursor(identity) && !store.getScanSourceRoot(identity) ? [{ runId: identity.runId, root: defaultRoot, scope: identity.scope }] : [];
    })];
    const registeredRoots = knownSources.filter(source => !runFilter || source.runId === runFilter).map(source => source.root);
    const roots = input.eventRoot ? [defaultRoot]
      : [...new Set([...(runFilter && registeredRoots.length ? [] : [defaultRoot]), ...registeredRoots])];
    const sources = (await Promise.all(roots.map(async root => {
      const events = new JsonlEventStore({ root });
      const runs = runFilter ? [runFilter] : [...new Set([...await events.listRuns(), ...knownSources.filter(source => source.root === root).map(source => source.runId)])];
      return runs.map(runId => ({ runId, events }));
    }))).flat();
    for (const { runId, events } of sources) {
      const registered = knownSources.filter(source => source.runId === runId);
      if (scopeFilter && registered.length && !registered.some(source => source.scope === scopeFilter)) continue;
      const priorRun = store.listRequests().filter(entry => entry.request.sourceRunId === runId
        && (!scopeFilter || entry.request.scope === scopeFilter)
        && store.getScanRequestKeys({ scope: entry.request.scope, runId, analyzerVersion: entry.request.analyzerVersion }).includes(entry.key));
      let scope: string | undefined;
      try {
        if (knownSources.some(source => source.runId === runId && source.root !== events.root)) throw new Error('source_not_allowed');
        const audit: EvidenceSourceInput = { id: 'audit-1', kind: 'audit', path: events.pathFor(runId), allowedRoot: events.root, runId };
        let bytes: Buffer | undefined;
        let history: RunEvent[];
        try {
          bytes = await readEvidenceSource(audit.path, audit.allowedRoot, 64 * 1024 * 1024);
          if (!bytes) throw new Error('audit_invalid');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EVIDENCE_SOURCE_UNSTABLE') throw new Error('audit_unstable');
          if (/safety limit/.test(error instanceof Error ? error.message : '')) throw new Error('source_limit');
          if (['EACCES', 'EPERM', 'EBUSY', 'EMFILE', 'ENFILE', 'EIO'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new Error('audit_unstable');
          throw new Error('audit_invalid');
        }
        let text: string;
        let incomplete = false;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch {
          if (bytes.at(-1) === 10) throw new Error('audit_invalid');
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytes.lastIndexOf(10) + 1)); }
          catch { throw new Error('audit_invalid'); }
          incomplete = true;
        }
        const lines = text.split('\n');
        history = lines.flatMap((line, index) => {
          if (!line.trim()) return [];
          try { return [JSON.parse(line) as RunEvent]; }
          catch {
            if (index !== lines.length - 1) throw new Error('audit_invalid');
            incomplete = true;
            return [];
          }
        });
        if (!verifyRunEventHistory(runId, history).valid) throw new Error('audit_invalid');
        for (const entry of priorRun) {
          const previous = store.getScanCursor({ scope: entry.request.scope, runId, analyzerVersion: entry.request.analyzerVersion });
          if (previous && history[previous.sequence - 1]?.integrity.hash !== previous.head) throw new Error('audit_changed');
        }
        if (!history.length && priorRun.length) throw new Error('audit_changed');
        if (!history.length && incomplete) throw new Error('audit_unstable');
        if (!history.length || history.every(event => event.context.purpose === 'learning')) continue;
        if (history.some(event => event.context.purpose === 'learning')) throw new Error('audit_invalid');
        scope = experienceScope(history[0].context.workItemId);
        if (scopeFilter && scopeFilter !== scope) continue;
        if (history.some(event => event.context.runId !== runId || event.context.workItemId !== history[0].context.workItemId)) throw new Error('audit_invalid');
        result.scanned += 1;
        const identity = { scope, runId, analyzerVersion };
        const cursor = store.getScanCursor(identity) ?? null;
        if (cursor && history[cursor.sequence - 1]?.integrity.hash !== cursor.head) throw new Error('audit_changed');
        const last = history.at(-1)!;
        const prior = priorRun.filter(entry => entry.request.scope === scope);
        const negative = history.filter(event => event.data.kind === 'qa.failed'
          || event.data.kind === 'run.finished' && event.data.outcome !== 'succeeded').at(-1)?.sequence ?? 0;
        result.invalidated += withdraw(store, prior.filter(entry => {
          const epoch = entry.request.sourceId.match(/:qa:(\d+):(?:complete|handoff|ready|merged)(?::sessions:[a-f0-9]{64})?$/)?.[1];
          return negative > Number(epoch ?? 0);
        }));
        if (incomplete) throw new Error('audit_unstable');
        let completion: ReturnType<typeof successfulRunEvidenceFromEvents> | undefined;
        try { completion = successfulRunEvidenceFromEvents({ scope, runId, workItemId: history[0].context.workItemId, evidence: [] }, history); }
        catch {}
        const requests = [];
        const snapshots: EvidencePack[] = [];
        if (completion) {
          const qa = history.filter(event => event.data.kind === 'qa.started').at(-1)!;
          const phase = history.some(event => event.data.kind === 'change.merge_verified' && !event.data.child && event.data.changeId === completion!.publishedChange)
            ? 'merged' : 'ready';
          const recorded = history.flatMap(event => event.data.kind === 'agent.session_recorded' ? [event.data] : []);
          const sessions = [...new Map(recorded.map(data => [data.sessionId, data])).values()]
            .sort((first, second) => first.sessionId < second.sessionId ? -1 : first.sessionId > second.sessionId ? 1 : 0);
          if (sessions.length > 63) throw new Error('source_limit');
          const sources: EvidenceSourceInput[] = [{ ...audit, expectedDigest: hash(bytes) }];
          for (const [index, session] of sessions.entries()) {
            const path = session.transcriptPath ?? join(allowedRoots[0], `missing-${hash(session.sessionId)}.jsonl`);
            const allowedRoot = isAbsolute(path) && allowedRoots.find(root => contains(root, path));
            if (!allowedRoot) throw new Error('source_not_allowed');
            sources.push({ id: `session-${index + 1}`, kind: 'session', path, allowedRoot });
          }
          const pack = await buildEvidencePack({ sources });
          const signature = hash(canonicalLearningJson({ sessions, sources: pack.sources.slice(1) }));
          const sourceId = `run:${hash(runId)}:qa:${qa.sequence}:${phase}:sessions:${signature}`;
          if (!prior.some(entry => entry.request.analyzerVersion === analyzerVersion && entry.request.sourceId === sourceId)) {
            snapshots.push(pack);
            requests.push({ request: { version: 1 as const, scope, sourceId, sourceRunId: runId,
              workItemId: history[0].context.workItemId, evidenceDigest: pack.digest, analyzerVersion,
              reason: history.some(event => event.data.kind === 'qa.failed' || event.data.kind === 'failure.classified') ? 'repaired' as const : 'completed' as const },
              evidence: pack.entries.map(entry => entry.ref) });
          }
        }
        if (cursor?.sequence !== last.sequence || requests.length) {
          store.commitScan({ ...identity, sourceRoot: events.root, expectedCursor: cursor, cursor: { sequence: last.sequence, head: last.integrity.hash }, requests }, snapshots);
        }
        if (completion) {
          for (const entry of prior.filter(entry => entry.blockedReason === 'source_unstable')) {
            store.setRequestBlocked(entry.key, null, 'source_unstable');
          }
          result.checkedSources.push({ runId, eventRoot: events.root });
        }
        result.submitted += requests.length;
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        const code = (error as NodeJS.ErrnoException).code === 'EVIDENCE_SOURCE_UNSTABLE' ? 'audit_unstable'
          : intakeCodes.has(message) ? message : /capacity|SQLITE_FULL|disk.*full/i.test(message) ? 'storage_blocked'
          : /exceeds.*limit|requires.*shard/i.test(message) ? 'source_limit' : 'evidence_unavailable';
        if (code === 'audit_invalid' || code === 'audit_changed') {
          result.invalidated += withdraw(store, priorRun);
        } else if (code === 'audit_unstable' || code === 'source_limit') {
          for (const entry of priorRun) {
            store.setRequestBlocked(entry.key, 'source_unstable', null);
          }
        }
        result.blocked.push({ runId, code, eventRoot: events.root });
      }
    }
    return result;
  } finally { store.close(); }
}

export async function submitLearningCorrection(input: {
  directory: string; scope: string; sourceId: string; correction: string; analyzerVersion?: string;
}): Promise<StoredDistillationRequest> {
  const scope = learningScopeSchema.parse(input.scope);
  const sourceId = learningIdentitySchema.parse(input.sourceId);
  const correction = redactEvidenceText(z.string().trim().min(1).max(32 * 1024).parse(input.correction));
  const actor = hash(String(process.getuid?.() ?? process.platform));
  const document = { origin: 'current-user-command', actor, source: hash(sourceId), scope, correction };
  const directory = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'learning-correction-'));
  try {
    const path = join(directory, 'correction.jsonl');
    await fs.writeFile(path, canonicalLearningJson(document) + '\n', { mode: 0o600 });
    const pack = await buildEvidencePack({ sources: [{ id: 'correction-1', kind: 'journal', path, allowedRoot: directory }] });
    return await submitDistillation({ directory: input.directory, pack,
      request: { version: 1, scope, sourceId: `correction:${hash(canonicalLearningJson(document))}`, evidenceDigest: pack.digest,
        analyzerVersion: learningIdentitySchema.parse(input.analyzerVersion ?? '1'), reason: 'correction' } });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
