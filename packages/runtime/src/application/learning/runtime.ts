import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
  scope: string; runId: string; evidence: readonly string[]; root?: string;
}): Promise<string[]> {
  parseCanonicalProject(input.scope);
  const events = new JsonlEventStore({ root: input.root ?? process.env.AFK_EVENT_STORE_DIR });
  const integrity = await events.verify(input.runId);
  if (!integrity.valid || !integrity.lastSequence) throw new Error('Experience verification requires an intact recorded run');
  let verified = false;
  let qaStarted = false;
  let completed = false;
  let failed = false;
  let publishedChange: string | undefined;
  for await (const event of events.read(input.runId)) {
    if (experienceScope(event.context.workItemId) !== input.scope) throw new Error('Verification run belongs to another project');
    const data = event.data;
    if (data.kind === 'qa.started') {
      qaStarted = true;
      verified = completed = false;
      publishedChange = undefined;
    }
    if (data.kind === 'qa.passed' && qaStarted) verified = true;
    if (data.kind === 'qa.failed') verified = completed = false;
    if (data.kind === 'change.published' && verified) publishedChange = data.changeId;
    if (verified && publishedChange && (
      (data.kind === 'human_gate.opened' && data.gateId === `merge:${publishedChange}`)
      || (data.kind === 'change.merge_verified' && data.changeId === publishedChange)
    )) completed = true;
    if (data.kind === 'run.finished') {
      if (data.outcome !== 'succeeded') failed = true;
      else if (verified) completed = true;
    }
  }
  if (!verified || !completed || failed) throw new Error('Experience verification requires a successful independent QA run');
  return [...new Set([...input.evidence, `run:${input.runId}#qa.passed`])];
}
