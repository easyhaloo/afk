import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { simpleGit } from 'simple-git';
import type { RunEvent } from '@afk/core';
import { parseCanonicalProject } from '../../domain/work-item/identity.js';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import { checkAbort } from '../../infrastructure/providers/dependencies.js';
import type { ContextFragment, ContextQuery, ContextSource, ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';
import type { PluginRuntime } from '../plugins/runtime.js';
import type { FailureDiagnostic } from '../workflows/failure-diagnostic.js';
import { writeReferenceContext } from '../workflows/context-file.js';
import { ExperienceStore, experienceContextMatches, experienceQueryContextSchema, type ExperienceQueryContext, type ExperienceRecord } from './experience-store.js';
import { experienceScope, successfulRunEvidenceFromEvents } from './run-evidence.js';

export { experienceScope, successfulRunEvidenceFromEvents } from './run-evidence.js';

export function experienceStorePath(homeDir = homedir()): string {
  return join(homeDir, '.afk', 'learning', 'experience.sqlite');
}

export function recordExecutionExperience(input: {
  failure: FailureDiagnostic; runId: string; workItemId: string; sourceEvent?: 'failure.classified' | 'qa.failed';
}): ExperienceRecord {
  const store = new ExperienceStore({ file: experienceStorePath() });
  try {
    return store.recordFailure({
      scope: experienceScope(input.workItemId), trigger: input.failure.code,
      rootCause: input.failure.message.slice(0, 480),
      action: `Inspect the ${input.failure.code} evidence and validate a correction before retrying.`,
      evidence: [`run:${input.runId}#${input.sourceEvent ?? 'failure.classified'}`],
      source: { runId: input.runId, workItemId: input.workItemId },
    });
  } finally { store.close(); }
}

export async function recordSuccessfulExperience(input: {
  runId: string; workItemId: string; root?: string; file?: string;
}): Promise<ExperienceRecord> {
  input = z.object({ runId: z.string().min(1).max(512).refine(value => !value.includes('\0')),
    workItemId: z.string().min(1).max(512), root: z.string().min(1).max(4096).optional(), file: z.string().min(1).max(4096).optional() }).strict().parse(input);
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
  const store = new ExperienceStore({ file: input.file ?? experienceStorePath() });
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

  constructor(private readonly file = experienceStorePath()) {}

  async gather(query: ContextQuery, options?: ProviderOperationOptions): Promise<readonly ContextFragment[]> {
    checkAbort(options);
    parseCanonicalProject(query.scope);
    if ((query.target && !Object.hasOwn(query, 'target')) || (query.applicability && !Object.hasOwn(query, 'applicability'))) return [];
    if (!existsSync(this.file)) return [];
    const store = new ExperienceStore({ file: this.file });
    try {
      return store.recall({ scope: query.scope, prompt: query.prompt.slice(0, 2000), limit: query.limit ?? 5, maxChars: 8000,
        applicability: query.applicability, target: query.target }).map(record => ({
        origin: `experience:${record.id}; verification:run:${record.verifiedEvidence!.runId}; expires:${record.expiresAt}`,
        content: `Trigger: ${record.trigger}\nRoot cause: ${record.rootCause}\nValidated correction: ${record.action}\nEvidence: ${record.verifiedEvidence!.evidence.join(', ')}`,
      }));
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
  workItemId: string; worktreePath: string; prompt: string; plugins?: PluginRuntime;
} & ExperienceQueryContext): Promise<string | undefined> {
  const scope = experienceScope(input.workItemId);
  const directory = join(await fs.realpath(input.worktreePath), '.afk');
  try {
    if (await fs.realpath(directory) !== directory) throw new Error('Experience context directory must not be a symbolic link');
    await fs.rm(join(directory, 'experience-context.md'), { force: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const context = await resolveExperienceQueryContext(input);
  const query: ContextQuery = { scope, prompt: input.prompt.slice(0, 2000), limit: 5, ...context };
  for (const value of [query.applicability, query.target?.conditions, query.target?.productVersions, query.target?.runtimeVersions, query.target, query]) {
    if (value) Object.freeze(value);
  }
  const providers = input.plugins
    ? [input.plugins.getContextProvider('context.experience'), input.plugins.getContextProvider('context.knowledge')]
    : [new ExperienceContextProvider()];
  const groups = await Promise.all(providers.map(provider => provider ? provider.gather(query) : []));
  const selected: ContextFragment[] = [];
  for (let index = 0; index < 5 && selected.length < 5; index++) {
    for (const group of groups) {
      const fragment = group[index];
      if (fragment?.content && selected.length < 5) selected.push({ ...fragment, origin: fragment.origin.slice(0, 1000) });
    }
  }
  let remaining = 7600;
  const fragments = selected.map((fragment, index) => {
    const available = Math.floor(remaining / (selected.length - index)) - fragment.origin.length - 16;
    const content = fragment.content.slice(0, available);
    remaining -= fragment.origin.length + content.length + 16;
    return { ...fragment, content };
  });
  if (fragments.length) return writeReferenceContext(input.worktreePath, 'experience-context.md', fragments);
  return undefined;
}

export async function verifyExperienceRun(input: {
  scope: string; runId: string; evidence: readonly string[]; root?: string; workItemId?: string;
}): Promise<string[]> {
  return (await successfulRunEvidence(input)).evidence;
}

export async function verifyApplicableExperience(input: {
  id: string; scope: string; runId: string; evidence: readonly string[]; context: ExperienceQueryContext;
  root?: string; file?: string;
}): Promise<ExperienceRecord> {
  const context = experienceQueryContextSchema.parse(input.context);
  const audit = await successfulRunEvidence(input);
  const target = audit.qaTarget;
  if (!target?.target?.revision || target.target.dirty !== false || target.target.project !== input.scope
    || target.target.revision !== audit.qaCommit || !experienceContextMatches(context, target)) {
    throw new Error('Experience applicability requires a trusted QA target matching the exact QA revision');
  }
  const store = new ExperienceStore({ file: input.file ?? experienceStorePath() });
  try {
    if (!store.get(input.id, input.scope)) throw new Error('Experience does not belong to verification scope');
    return store.verify(input.id, { runId: input.runId, evidence: audit.evidence }, context);
  } finally { store.close(); }
}

export async function verifyAdoptionRun(input: {
  scope: string; runId: string; workItemId: string; root?: string;
}): Promise<void> {
  const parsed = z.object({ scope: z.string().min(1).max(512), runId: z.string().min(1).max(512).refine(value => value.trim() === value && !value.includes('\0')),
    workItemId: z.string().min(1).max(512), root: z.string().min(1).max(4096).optional() }).strict().parse(input);
  parseCanonicalProject(parsed.scope);
  if (experienceScope(parsed.workItemId) !== parsed.scope) throw new Error('Adoption work item does not belong to scope');
  const events = new JsonlEventStore({ root: parsed.root ?? process.env.AFK_EVENT_STORE_DIR });
  const integrity = await events.verify(parsed.runId);
  if (!integrity.valid || !integrity.lastSequence) throw new Error('Adoption requires an intact recorded run');
  let recorded = false;
  for await (const event of events.read(parsed.runId)) {
    recorded = true;
    if (event.context.runId !== parsed.runId || event.context.workItemId !== parsed.workItemId) {
      throw new Error('Adoption run does not belong to the exact work item');
    }
  }
  if (!recorded) throw new Error('Adoption requires an intact recorded run');
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
