import { constants, existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { simpleGit } from 'simple-git';
import type { RunEvent } from '@afk/core';
import { parseCanonicalProject } from '../../domain/work-item/identity.js';
import { JsonlEventStore, verifyRunEventHistory } from '../../infrastructure/observability/jsonl-event-store.js';
import { checkAbort } from '../../infrastructure/providers/dependencies.js';
import type { ContextFragment, ContextQuery, ContextSource, ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';
import type { PluginRuntime } from '../plugins/runtime.js';
import type { FailureDiagnostic } from '../workflows/failure-diagnostic.js';
import { serializeReferenceContext, writeReferenceContext } from '../workflows/context-file.js';
import { ExperienceStore, experienceContextMatches, experienceQueryContextSchema, type ExperienceAdoptionContext, type ExperienceContextReceipt, type ExperienceOutcomeReceipt, type ExperienceQueryContext, type ExperienceRecord, type RecordFailureInput } from './experience-store.js';
import { adoptionRunContextFromEvents, experienceScope, successfulRunEvidenceFromEvents } from './run-evidence.js';
import type { KnowledgeRuntimeOptions } from './knowledge-runtime.js';

export { experienceScope, successfulRunEvidenceFromEvents } from './run-evidence.js';

export class ExperienceFeedbackError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExperienceFeedbackError';
  }
}

export function experienceStorePath(homeDir = homedir()): string {
  return join(homeDir, '.afk', 'learning', 'experience.sqlite');
}

export function recordExecutionExperience(input: {
  failure: FailureDiagnostic; runId: string; workItemId: string; sourceEvent?: 'failure.classified' | 'qa.failed'; plugins?: PluginRuntime;
}): ExperienceRecord | undefined {
  const failure: RecordFailureInput = {
    scope: experienceScope(input.workItemId), trigger: input.failure.code,
    rootCause: input.failure.message.slice(0, 480),
    action: `Inspect the ${input.failure.code} evidence and validate a correction before retrying.`,
    evidence: [`run:${input.runId}#${input.sourceEvent ?? 'failure.classified'}`],
    source: { runId: input.runId, workItemId: input.workItemId },
  };
  const provider = input.plugins?.getContextProvider('context.experience');
  if (provider instanceof ExperienceContextProvider) return provider.recordUnselectedFailure(failure);
  if (provider) throw new ExperienceFeedbackError('Configured experience provider does not support failure collection');
  const homeDir = homedir();
  const store = new ExperienceStore({ file: experienceStorePath(homeDir), homeDir });
  try {
    return store.recordUnselectedFailure(failure);
  } finally { store.close(); }
}

export async function recordExperienceOutcomes(input: {
  runId: string; workItemId: string; root?: string; file?: string; homeDir?: string;
  event?: { sequence: number; hash: string };
}): Promise<ExperienceOutcomeReceipt[]> {
  const identity = z.string().min(1).max(512).refine(value => value.trim() === value && !value.includes('\0'));
  const parsed = z.object({ runId: identity, workItemId: identity, root: z.string().min(1).max(4096).optional(),
    file: z.string().min(1).max(4096).optional(), homeDir: z.string().min(1).max(4096).optional(),
    event: z.object({ sequence: z.number().int().positive().safe(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  }).strict().parse(input);
  const scope = experienceScope(parsed.workItemId);
  const homeDir = parsed.homeDir ?? (parsed.file === undefined ? homedir() : undefined);
  const file = parsed.file ?? experienceStorePath(homeDir);
  if (!existsSync(file)) return [];
  const events = new JsonlEventStore({ root: parsed.root ?? process.env.AFK_EVENT_STORE_DIR });
  const history: RunEvent[] = [];
  for await (const event of events.read(parsed.runId)) history.push(event);
  if (!verifyRunEventHistory(parsed.runId, history).valid || history.some(event => event.schemaVersion !== 1
    || event.context.workItemId !== parsed.workItemId || event.correlationId !== parsed.runId || event.type !== event.data.kind)) {
    throw new ExperienceFeedbackError('Experience outcome requires an intact audit for the exact run and work item');
  }
  if (parsed.event && !history.some(event => event.sequence === parsed.event!.sequence && event.integrity.hash === parsed.event!.hash)) {
    throw new ExperienceFeedbackError('Experience outcome event does not match the persisted audit receipt');
  }
  const store = new ExperienceStore({ file, homeDir });
  try {
    const receipts: ExperienceOutcomeReceipt[] = [];
    for (const event of history) {
      if (parsed.event && event.sequence !== parsed.event.sequence) continue;
      if (event.context.purpose === 'learning' || !['system', 'cli', 'loop'].includes(event.context.actor?.kind)) continue;
      const data = event.data;
      if (data.kind !== 'run.finished' && data.kind !== 'qa.failed' && data.kind !== 'failure.classified') continue;
      const source = { runId: parsed.runId, workItemId: parsed.workItemId };
      let failure: RecordFailureInput | undefined;
      const code = data.kind === 'failure.classified' ? data.code
        : data.kind === 'qa.failed' ? data.reasonCode ?? (data.reason === 'rework' ? 'qa_rework' : 'qa_execution_failed') : undefined;
      if (code && (data.kind === 'failure.classified' || data.kind === 'qa.failed')) {
        failure = { scope, source, trigger: code,
          rootCause: (data.summary ?? `Independent QA ${data.kind === 'qa.failed' ? data.reason ?? 'failed' : 'failed'}`).slice(0, 480),
          action: `Inspect the ${code} evidence and validate a correction before retrying.`,
          evidence: [`run:${parsed.runId}#${data.kind}`] };
      }
      receipts.push(...store.recordRunOutcome({ scope, source, failure, event: { runId: parsed.runId,
        sequence: event.sequence, hash: event.integrity.hash, type: data.kind,
        outcome: data.kind === 'run.finished' ? data.outcome : 'failed', occurredAt: event.occurredAt, observedAt: event.observedAt } }).receipts);
    }
    return receipts;
  } finally { store.close(); }
}

export async function recordSuccessfulExperience(input: {
  runId: string; workItemId: string; root?: string; file?: string; homeDir?: string;
}): Promise<ExperienceRecord> {
  input = z.object({ runId: z.string().min(1).max(512).refine(value => !value.includes('\0')),
    workItemId: z.string().min(1).max(512), root: z.string().min(1).max(4096).optional(), file: z.string().min(1).max(4096).optional(),
    homeDir: z.string().min(1).max(4096).optional() }).strict().parse(input);
  const scope = experienceScope(input.workItemId);
  const audit = await successfulRunEvidence({ scope, runId: input.runId, workItemId: input.workItemId, evidence: [], root: input.root });
  const workflow = audit.workflowName ? `${audit.workflowName} workflow` : 'recorded task workflow';
  const evidence = [...audit.evidence, `run:${input.runId}#${audit.completionEvent}`];
  if (audit.workflowName) evidence.push(`run:${input.runId}#workflow.recorded`);
  const artifacts: string[] = [];
  if (audit.implementationCommit) {
    evidence.push(`run:${input.runId}#commit.recorded:implementation:${audit.implementationCommit}`);
    artifacts.push(`implementation commit ${audit.implementationCommit}`);
  }
  if (audit.qaCommit) {
    evidence.push(`run:${input.runId}#commit.recorded:qa:${audit.qaCommit}`);
    artifacts.push(`QA commit ${audit.qaCommit}`);
  }
  if (audit.changeUrl) { evidence.push(audit.changeUrl); artifacts.push(`published change ${audit.changeUrl}`); }
  const homeDir = input.homeDir ?? (input.file === undefined ? homedir() : undefined);
  const store = new ExperienceStore({ file: input.file ?? experienceStorePath(homeDir), homeDir });
  try {
    return store.recordSuccess({ scope, trigger: `${workflow}: independent QA and successful completion`,
      rootCause: 'Evidence-linked workflow route: the intact task audit records qa.started, qa.passed, and a matching merge handoff or successful run finish.',
      action: `${artifacts.length ? `Inspect the recorded ${artifacts.join(', ')} before reusing this workflow route. ` : ''}Reuse the ${workflow} route: run independent QA, then ${audit.publishedChange ? 'publish the verified change for human review' : 'complete the task after QA passes'}.`,
      source: { runId: input.runId, workItemId: input.workItemId }, evidence });
  } finally { store.close(); }
}

export class ExperienceContextProvider implements ContextSource {
  readonly id = 'context.experience';
  readonly capabilities = { 'read-only': true, summarize: false, search: true } as const;

  private readonly file: string;
  private readonly options: { homeDir?: string; knowledge?: KnowledgeRuntimeOptions };

  constructor(file?: string, options: { homeDir?: string; knowledge?: KnowledgeRuntimeOptions } = {}) {
    const homeDir = options.homeDir ?? (file === undefined ? homedir() : undefined);
    this.file = file ?? experienceStorePath(homeDir);
    this.options = { ...options, homeDir };
  }

  async gather(query: ContextQuery, options?: ProviderOperationOptions): Promise<readonly ContextFragment[]> {
    return this.read(query, options).map(result => result.fragment);
  }

  gatherForRun(query: ContextQuery, source: { runId: string; workItemId: string }, options?: ProviderOperationOptions) {
    try { return this.read(query, options, source); }
    catch (cause) { throw new ExperienceFeedbackError('Experience retrieval feedback is incomplete', { cause }); }
  }

  recordSelections(selections: readonly { receipt: ExperienceContextReceipt; content: string }[]): void {
    const store = new ExperienceStore({ file: this.file, ...this.options });
    try {
      for (const selection of selections) store.recordContextSelection({ retrieved: selection.receipt,
        fragmentDigest: createHash('sha256').update(selection.content).digest('hex') });
    } finally { store.close(); }
  }

  recordOutcomes(input: Omit<Parameters<typeof recordExperienceOutcomes>[0], 'file' | 'homeDir'>): Promise<ExperienceOutcomeReceipt[]> {
    return recordExperienceOutcomes({ ...input, file: this.file, homeDir: this.options.homeDir });
  }

  recordUnselectedFailure(input: RecordFailureInput): ExperienceRecord | undefined {
    const store = new ExperienceStore({ file: this.file, ...this.options });
    try { return store.recordUnselectedFailure(input); }
    finally { store.close(); }
  }

  private read(query: ContextQuery, options?: ProviderOperationOptions, source?: { runId: string; workItemId: string }):
    { fragment: ContextFragment; receipt?: ExperienceContextReceipt }[] {
    checkAbort(options);
    parseCanonicalProject(query.scope);
    if ((query.target && !Object.hasOwn(query, 'target')) || (query.applicability && !Object.hasOwn(query, 'applicability'))) return [];
    if (!existsSync(this.file)) return [];
    const store = new ExperienceStore({ file: this.file, ...this.options });
    try {
      return store.recall({ scope: query.scope, prompt: query.prompt.slice(0, 2000), limit: query.limit ?? 5, maxChars: 8000,
        applicability: query.applicability, target: query.target }).map(record => {
        const fragment = {
          origin: `experience:${record.id}; verification:run:${record.verifiedEvidence!.runId}; expires:${record.expiresAt}`,
          content: `Trigger: ${record.trigger}\nRoot cause: ${record.rootCause}\nValidated correction: ${record.action}\nEvidence: ${record.verifiedEvidence!.evidence.join(', ')}`,
        };
        const receipt = source ? store.recordContextRetrieval({ id: record.id, scope: query.scope, source, expectedRecord: record,
          selectionId: randomUUID(), fragmentDigest: createHash('sha256').update(fragment.content).digest('hex') },
        { applicability: query.applicability, target: query.target }) : undefined;
        return { fragment, receipt };
      });
    } finally { store.close(); }
  }
}

export async function resolveExperienceQueryContext(input: {
  workItemId: string; worktreePath: string; plugins?: PluginRuntime;
} & ExperienceQueryContext): Promise<ExperienceQueryContext> {
  const scope = experienceScope(input.workItemId);
  if ((input.target && !Object.hasOwn(input, 'target')) || (input.applicability && !Object.hasOwn(input, 'applicability'))) {
    throw new Error('Execution context must use own properties');
  }
  const explicit = experienceQueryContextSchema.parse({ applicability: input.applicability, target: input.target });
  const configured = input.plugins?.listSystemActions().includes('learning.context')
    ? experienceQueryContextSchema.parse(await input.plugins.dispatchSystemAction('learning.context', { scope })) : {};
  if (configured.target && configured.target.project !== scope) throw new Error('Configured execution target belongs to another project');
  const context = experienceQueryContextSchema.parse({
    applicability: explicit.applicability || configured.applicability
      ? { ...configured.applicability, ...explicit.applicability } : undefined,
    target: explicit.target || configured.target ? { ...configured.target, ...explicit.target } : undefined,
  });
  if (context.target && context.target.project !== scope) throw new Error('Execution target belongs to another project');
  let revision: string | undefined;
  let dirty: boolean | undefined;
  try {
    const git = simpleGit(input.worktreePath);
    const root = await fs.realpath(input.worktreePath);
    if (await fs.realpath((await git.revparse(['--show-toplevel'])).trim()) === root) {
      const before = (await git.revparse('HEAD')).trim().toLowerCase();
      const status = await git.status(['--untracked-files=all']);
      const after = (await git.revparse('HEAD')).trim().toLowerCase();
      if (before === after && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(after)) {
        revision = after;
        dirty = !status.isClean();
      }
    }
  } catch {}
  return { applicability: context.applicability, target: { ...context.target, project: scope, revision, dirty } };
}

export async function prepareExperienceContext(input: {
  onContext?: (context: ExperienceQueryContext) => void;
  source?: { runId: string; workItemId: string }; workItemId: string; worktreePath: string; prompt: string; plugins?: PluginRuntime;
} & ExperienceQueryContext): Promise<{ path: string; recordSelection: () => Promise<void> } | undefined> {
  const source = input.source ? { runId: input.source.runId, workItemId: input.source.workItemId } : undefined;
  if (source && (source.workItemId !== input.workItemId || typeof source.runId !== 'string' || !source.runId.trim()
    || source.runId.trim() !== source.runId || source.runId.length > 512 || source.runId.includes('\0'))) {
    throw new ExperienceFeedbackError('Experience feedback requires the exact execution run and work item');
  }
  const scope = experienceScope(input.workItemId);
  const directory = join(await fs.realpath(input.worktreePath), '.afk');
  try {
    if (await fs.realpath(directory) !== directory) throw new Error('Experience context directory must not be a symbolic link');
    await fs.rm(join(directory, 'experience-context.md'), { force: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const context = await resolveExperienceQueryContext(input);
  input.onContext?.(context);
  const query: ContextQuery = { scope, prompt: input.prompt.slice(0, 2000), limit: 5, ...context };
  for (const value of [query.applicability, query.target?.conditions, query.target?.productVersions, query.target?.runtimeVersions, query.target, query]) {
    if (value) Object.freeze(value);
  }
  const providers = input.plugins
    ? [input.plugins.getContextProvider('context.experience'), input.plugins.getContextProvider('context.knowledge'),
      input.plugins.getContextProvider('context.installed-tools')]
    : [new ExperienceContextProvider(undefined, { homeDir: homedir() })];
  const groups = await Promise.all(providers.map(async provider => {
    if (provider instanceof ExperienceContextProvider && source) {
      return provider.gatherForRun(query, source)
        .map(result => ({ ...result, provider }));
    }
    return (provider ? await provider.gather(query) : []).map(fragment => ({ fragment, receipt: undefined, provider: undefined }));
  }));
  const selected: (typeof groups)[number][number][] = [];
  for (let index = 0; index < 5 && selected.length < 5; index++) {
    for (const group of groups) {
      const result = group[index];
      if (result?.fragment.content && selected.length < 5) selected.push({ ...result,
        fragment: { ...result.fragment, origin: result.fragment.origin.slice(0, 1000) } });
    }
  }
  let remaining = 7600;
  const retained = selected.map((result, index) => {
    const fragment = result.fragment;
    const available = Math.floor(remaining / (selected.length - index)) - fragment.origin.length - 16;
    const content = fragment.content.slice(0, Math.max(0, available));
    remaining -= fragment.origin.length + content.length + 16;
    return { ...result, fragment: { ...fragment, content } };
  }).filter(result => result.fragment.content.length > 0);
  if (!retained.length) return undefined;
  const fragments = retained.map(result => result.fragment);
  const serialized = Buffer.from(serializeReferenceContext(fragments), 'utf8');
  const digest = createHash('sha256').update(serialized).digest('hex');
  const path = await writeReferenceContext(input.worktreePath, 'experience-context.md', fragments);
  return { path, recordSelection: async () => {
    if (!retained.some(result => result.receipt)) return;
    try {
      if (await fs.realpath(directory) !== directory) throw new Error('Prepared experience reference directory changed before feedback');
      const target = join(directory, 'experience-context.md');
      const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const metadata = await handle.stat();
        const current = await fs.lstat(target);
        const observed = Buffer.alloc(serialized.length + 1);
        if (!metadata.isFile() || metadata.size !== serialized.length || !current.isFile() || current.isSymbolicLink()
          || current.dev !== metadata.dev || current.ino !== metadata.ino || await fs.realpath(directory) !== directory
          || (await handle.read(observed, 0, observed.length, 0)).bytesRead !== serialized.length
          || createHash('sha256').update(observed.subarray(0, serialized.length)).digest('hex') !== digest) {
          throw new Error('Prepared experience reference changed before feedback');
        }
      } finally { await handle.close(); }
      for (const provider of providers) {
        if (!(provider instanceof ExperienceContextProvider)) continue;
        const selections = retained.filter(result => result.provider === provider && result.receipt)
          .map(result => ({ receipt: result.receipt!, content: result.fragment.content }));
        if (selections.length) provider.recordSelections(selections);
      }
    } catch (cause) {
      throw new ExperienceFeedbackError('Execution accepted the experience reference, but selection feedback is incomplete', { cause });
    }
  } };
}

export async function verifyExperienceRun(input: {
  scope: string; runId: string; evidence: readonly string[]; root?: string; workItemId?: string;
}): Promise<string[]> {
  return (await successfulRunEvidence(input)).evidence;
}

export async function verifyApplicableExperience(input: {
  id: string; scope: string; runId: string; evidence: readonly string[]; context: ExperienceQueryContext;
  root?: string; file?: string; homeDir?: string;
}): Promise<ExperienceRecord> {
  const context = experienceQueryContextSchema.parse(input.context);
  const audit = await successfulRunEvidence(input);
  const target = audit.qaTarget;
  if (!target?.target?.revision || target.target.dirty !== false || target.target.project !== input.scope
    || target.target.revision !== audit.qaCommit || !experienceContextMatches(context, target)) {
    throw new Error('Experience applicability requires a trusted QA target matching the exact QA revision');
  }
  const homeDir = input.homeDir ?? (input.file === undefined ? homedir() : undefined);
  const store = new ExperienceStore({ file: input.file ?? experienceStorePath(homeDir), homeDir });
  try {
    if (!store.get(input.id, input.scope)) throw new Error('Experience does not belong to verification scope');
    return store.verify(input.id, { runId: input.runId, evidence: audit.evidence }, context);
  } finally { store.close(); }
}

export async function verifyAdoptionRun(input: {
  scope: string; runId: string; workItemId: string; root?: string;
}): Promise<ExperienceAdoptionContext> {
  const parsed = z.object({ scope: z.string().min(1).max(512), runId: z.string().min(1).max(512).refine(value => value.trim() === value && !value.includes('\0')),
    workItemId: z.string().min(1).max(512), root: z.string().min(1).max(4096).optional() }).strict().parse(input);
  parseCanonicalProject(parsed.scope);
  if (experienceScope(parsed.workItemId) !== parsed.scope) throw new Error('Adoption work item does not belong to scope');
  const events = new JsonlEventStore({ root: parsed.root ?? process.env.AFK_EVENT_STORE_DIR });
  const integrity = await events.verify(parsed.runId);
  if (!integrity.valid || !integrity.lastSequence) throw new Error('Adoption requires an intact recorded run');
  const history: RunEvent[] = [];
  for await (const event of events.read(parsed.runId)) {
    if (event.context.runId !== parsed.runId || event.context.workItemId !== parsed.workItemId) {
      throw new Error('Adoption run does not belong to the exact work item');
    }
    history.push(event);
  }
  if (!history.length) throw new Error('Adoption requires an intact recorded run');
  return adoptionRunContextFromEvents({ ...parsed, evidence: [] }, history);
}

async function successfulRunEvidence(input: Parameters<typeof verifyExperienceRun>[0]): Promise<{
  evidence: string[]; workflowName?: string; publishedChange?: string; completionEvent: string;
  implementationCommit?: string; qaCommit?: string; changeUrl?: string; qaTarget?: ExperienceQueryContext;
}> {
  parseCanonicalProject(input.scope);
  const events = new JsonlEventStore({ root: input.root ?? process.env.AFK_EVENT_STORE_DIR });
  const integrity = await events.verify(input.runId);
  if (!integrity.valid || !integrity.lastSequence) throw new Error('Experience verification requires an intact recorded run');
  const history: RunEvent[] = [];
  for await (const event of events.read(input.runId)) history.push(event);
  return successfulRunEvidenceFromEvents(input, history);
}
