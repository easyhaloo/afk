import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { parseCanonicalProject, parseWorkItemId } from '../../domain/work-item/identity.js';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import { checkAbort } from '../../infrastructure/providers/dependencies.js';
import type { ContextFragment, ContextQuery, ContextSource, ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';
import type { PluginRuntime } from '../plugins/runtime.js';
import type { FailureDiagnostic } from '../workflows/failure-diagnostic.js';
import { writeReferenceContext } from '../workflows/context-file.js';
import { ExperienceStore, type ExperienceRecord } from './experience-store.js';

export function experienceStorePath(homeDir = homedir()): string {
  return join(homeDir, '.afk', 'learning', 'experience.sqlite');
}

export function experienceScope(workItemId: string): string {
  const identity = parseWorkItemId(workItemId);
  return `${identity.platform}:${identity.projectKey}`;
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
    if (!existsSync(this.file)) return [];
    const store = new ExperienceStore({ file: this.file });
    try {
      return store.recall({ scope: query.scope, prompt: query.prompt.slice(0, 2000), limit: query.limit ?? 5, maxChars: 8000 }).map(record => ({
        origin: `experience:${record.id}; verification:run:${record.verifiedEvidence!.runId}; expires:${record.expiresAt}`,
        content: `Trigger: ${record.trigger}\nRoot cause: ${record.rootCause}\nValidated correction: ${record.action}\nEvidence: ${record.verifiedEvidence!.evidence.join(', ')}`,
      }));
    } finally { store.close(); }
  }
}

export async function prepareExperienceContext(input: {
  workItemId: string; worktreePath: string; prompt: string; plugins?: PluginRuntime;
}): Promise<string | undefined> {
  const scope = experienceScope(input.workItemId);
  const directory = join(await fs.realpath(input.worktreePath), '.afk');
  try {
    if (await fs.realpath(directory) !== directory) throw new Error('Experience context directory must not be a symbolic link');
    await fs.rm(join(directory, 'experience-context.md'), { force: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const provider = input.plugins ? input.plugins.getContextProvider('context.experience') : new ExperienceContextProvider();
  const fragments = provider ? await provider.gather({ scope, prompt: input.prompt, limit: 5 }) : [];
  if (fragments.length) return writeReferenceContext(input.worktreePath, 'experience-context.md', fragments);
  return undefined;
}

export async function verifyExperienceRun(input: {
  scope: string; runId: string; evidence: readonly string[]; root?: string; workItemId?: string;
}): Promise<string[]> {
  return (await successfulRunEvidence(input)).evidence;
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
  implementationCommit?: string; qaCommit?: string; changeUrl?: string;
}> {
  parseCanonicalProject(input.scope);
  const events = new JsonlEventStore({ root: input.root ?? process.env.AFK_EVENT_STORE_DIR });
  const integrity = await events.verify(input.runId);
  if (!integrity.valid || !integrity.lastSequence) throw new Error('Experience verification requires an intact recorded run');
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
  for await (const event of events.read(input.runId)) {
    if (experienceScope(event.context.workItemId) !== input.scope) throw new Error('Verification run belongs to another project');
    if (input.workItemId !== undefined && event.context.workItemId !== input.workItemId) throw new Error('Verification run belongs to another work item');
    const data = event.data;
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
    }
    if (data.kind === 'qa.passed' && qaStarted) verified = true;
    if (data.kind === 'qa.failed') verified = completed = false;
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
    implementationCommit, qaCommit, changeUrl };
}
