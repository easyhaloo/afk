import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { ContextFragment, ContextQuery, ContextSource, ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';
import { checkAbort } from '../../infrastructure/providers/dependencies.js';
import { recallTerms } from '../../domain/context/terms.js';
import { CandidateStore } from './candidate-store.js';
import { learningScopeSchema, type CandidateProposal } from './contracts.js';
import { readKnowledgeGrant, type KnowledgePolicy } from './knowledge.js';
import { prepareKnowledgePublication, publishLearningCandidate, readCurrentPublishedKnowledge, readPublishedKnowledge, reconcileKnowledgePublications, resolveKnowledgePublication,
  type KnowledgePublicationResult, type PublicationOptions } from './publication.js';
import { learningDigestSchema } from './requests.js';
import { verifyLessonPublication } from './lesson-publication-guard.js';
import type { ExperienceQueryContext } from './experience-store.js';
import { sourceReadCheck, sourceReadPathSchema } from './source-read-grant.js';

const savedPath = z.string().min(1).max(4096).refine(value => isAbsolute(value) && resolve(value) === value && !value.includes('\0'));
export const knowledgeConfigurationSchema = z.object({ wikiScript: savedPath,
  sourceReadGrantFile: sourceReadPathSchema.optional(),
  grants: z.array(savedPath).min(1).max(64).refine(values => new Set(values).size === values.length) }).strict();
export type KnowledgeConfiguration = z.infer<typeof knowledgeConfigurationSchema>;
export type KnowledgeRuntimeOptions = { file: string; recoveryDirectory: string; config: KnowledgeConfiguration;
  validationConfigurationFile?: string; homeDir?: string; signal?: AbortSignal };
type Binding = { grantIndex: number; authorizationFile: string; policy: KnowledgePolicy };
type BindingFailure = { grantIndex: number; code: 'knowledge_grant_unavailable' | 'knowledge_target_ambiguous' };

function loadBindings(config: KnowledgeConfiguration): { bindings: Binding[]; blocked: BindingFailure[] } {
  const parsed = knowledgeConfigurationSchema.parse(config);
  const bindings: Binding[] = [];
  const blocked: BindingFailure[] = [];
  for (const [grantIndex, authorizationFile] of parsed.grants.entries()) {
    try { bindings.push({ grantIndex, authorizationFile, policy: readKnowledgeGrant(authorizationFile).policy }); }
    catch { blocked.push({ grantIndex, code: 'knowledge_grant_unavailable' }); }
  }
  const owners = new Map<string, number>();
  const ambiguous = new Set<number>();
  for (const binding of bindings) {
    for (const target of binding.policy.targets) {
      const key = JSON.stringify([binding.policy.scope, target.ref]);
      const previous = owners.get(key);
      if (previous !== undefined) { ambiguous.add(previous); ambiguous.add(binding.grantIndex); }
      owners.set(key, binding.grantIndex);
    }
  }
  for (const grantIndex of ambiguous) blocked.push({ grantIndex, code: 'knowledge_target_ambiguous' });
  return { bindings: bindings.filter(binding => !ambiguous.has(binding.grantIndex)), blocked };
}

function route(options: KnowledgeRuntimeOptions, store: CandidateStore, scope: string, targetRef?: string): PublicationOptions {
  learningScopeSchema.parse(scope);
  const { bindings } = loadBindings(options.config);
  const matches = bindings.filter(binding => binding.policy.scope === scope && binding.policy.targets.some(target => target.ref === targetRef));
  if (matches.length !== 1) throw new Error('knowledge_target_unavailable_or_ambiguous');
  return { ...matches[0]!, store, wikiScript: options.config.wikiScript, recoveryDirectory: options.recoveryDirectory,
    validationConfigurationFile: options.validationConfigurationFile, homeDir: options.homeDir, signal: options.signal };
}

export function readConfiguredPublishedLesson(options: KnowledgeRuntimeOptions, input: {
  scope: string; key: string; context?: ExperienceQueryContext;
}) {
  checkAbort(options);
  savedPath.parse(options.file);
  savedPath.parse(options.recoveryDirectory);
  if (!existsSync(options.file)) return null;
  const store = new CandidateStore({ file: options.file });
  try {
    const publication = store.getPublication(learningDigestSchema.parse(input.key));
    if (!publication || publication.phase !== 'committed') return null;
    const checkSourceRead = sourceReadCheck(options.config.sourceReadGrantFile, input.scope, publication);
    checkSourceRead?.();
    const candidate = store.getCandidate(publication.candidateId);
    if (!candidate || candidate.state !== 'published'
      || candidate.proposal.kind !== 'lesson' || candidate.proposal.applicability.project !== learningScopeSchema.parse(input.scope)) return null;
    const applicability = candidate.proposal.applicability;
    const conditions = Object.fromEntries([...applicability.preconditions.map(name => [name, true]),
      ...applicability.exclusions.map(name => [name, false]), ...applicability.invalidationConditions.map(name => [name, false])]);
    const context: ExperienceQueryContext = input.context ?? { applicability: { version: applicability.versions[0], environment: applicability.environments[0] },
      target: { project: input.scope, conditions, ...(applicability.productId !== undefined
        ? { productVersions: { [applicability.productId]: applicability.versions[0] } } : {}) } };
    const knowledge = readCurrentPublishedKnowledge({ ...route(options, store, input.scope, publication.targetRef),
      key: publication.key, sourceReadGrantFile: options.config.sourceReadGrantFile, applicability: context.applicability, target: context.target });
    if (!knowledge || knowledge.classification !== 'lesson') return null;
    const qualification = verifyLessonPublication({ store, candidate, configurationFile: options.validationConfigurationFile, homeDir: options.homeDir, checkSourceRead }, { signal: options.signal });
    checkAbort(options);
    if (qualification.status !== 'current') return null;
    const request = store.getRequest(candidate.requestKey)?.request;
    const validation = store.getValidation(candidate.id);
    if (!request?.sourceRunId || !request.workItemId || !validation) return null;
    checkAbort(options);
    checkSourceRead?.();
    return { candidate, publication, request, qualification, validation, checkSourceRead };
  } catch { checkAbort(options); return null; }
  finally { store.close(); }
}

async function withStore<Result>(options: Pick<KnowledgeRuntimeOptions, 'file' | 'recoveryDirectory' | 'signal'>,
  operation: (store: CandidateStore) => Promise<Result>): Promise<Result> {
  checkAbort(options);
  savedPath.parse(options.file);
  savedPath.parse(options.recoveryDirectory);
  if (!existsSync(options.file)) throw new Error('knowledge_candidate_store_unavailable');
  const store = new CandidateStore({ file: options.file });
  try { return await operation(store); } finally { store.close(); }
}

export async function prepareConfiguredKnowledge(input: KnowledgeRuntimeOptions & {
  scope: string; candidateId: string; expectedVersion: number; targetRef?: string;
}) {
  return withStore(input, async store => {
    const candidate = store.getCandidate(learningDigestSchema.parse(input.candidateId));
    if (!candidate || candidate.proposal.applicability.project !== learningScopeSchema.parse(input.scope)) throw new Error('knowledge_candidate_scope_mismatch');
    const targetRef = input.targetRef ?? candidate.proposal.targetRef;
    return prepareKnowledgePublication({ ...route(input, store, input.scope, targetRef), candidateId: candidate.id,
      expectedVersion: input.expectedVersion, targetRef });
  });
}

export async function publishConfiguredKnowledge(input: KnowledgeRuntimeOptions & { scope: string; key: string }) {
  const result = await withStore(input, async store => {
    const publication = store.getPublication(learningDigestSchema.parse(input.key));
    const candidate = publication && store.getCandidate(publication.candidateId);
    if (!candidate || candidate.proposal.applicability.project !== learningScopeSchema.parse(input.scope)) throw new Error('knowledge_candidate_scope_mismatch');
    return publishLearningCandidate({ ...route(input, store, input.scope, publication!.targetRef), key: input.key });
  });
  const blocked = await projectConfiguredLessons(input, [result.publication.key]);
  return { ...result, experienceProjection: { blocked } };
}

async function projectConfiguredLessons(input: KnowledgeRuntimeOptions, keys: string[]): Promise<string[]> {
  checkAbort(input);
  if (!keys.length) return [];
  try {
    const lessons = await withStore(input, async store => keys.flatMap(key => {
      const publication = store.getPublication(key);
      const candidate = publication && store.getCandidate(publication.candidateId);
      return publication?.phase === 'committed' && candidate?.state === 'published' && candidate.proposal.kind === 'lesson'
        ? [{ scope: candidate.proposal.applicability.project, key }] : [];
    }));
    if (!lessons.length) return [];
    const { ExperienceStore } = await import('./experience-store.js');
    const experience = new ExperienceStore({ file: join(dirname(input.file), 'experience.sqlite'), knowledge: input });
    const blocked: string[] = [];
    try {
      for (const lesson of lessons) {
        checkAbort(input);
        try { experience.projectPublishedLesson(lesson); }
        catch { checkAbort(input); blocked.push(lesson.key); }
      }
      return blocked;
    } finally { experience.close(); }
  } catch { checkAbort(input); return keys; }
}

export async function reconcileConfiguredLessons(input: Pick<KnowledgeRuntimeOptions, 'file' | 'recoveryDirectory' | 'validationConfigurationFile' | 'homeDir' | 'signal'>
  & { scope?: string }): Promise<{ invalidated: string[] }> {
  if (input.scope !== undefined) learningScopeSchema.parse(input.scope);
  checkAbort(input);
  if (!existsSync(input.file)) return { invalidated: [] };
  return withStore(input, async store => {
    const invalidated: string[] = [];
    for (const candidate of store.listCandidates()) {
      checkAbort(input);
      if (candidate.proposal.kind !== 'lesson' || !['validated', 'published'].includes(candidate.state)
        || (input.scope !== undefined && candidate.proposal.applicability.project !== input.scope)) continue;
      const result = verifyLessonPublication({ store, candidate, configurationFile: input.validationConfigurationFile, homeDir: input.homeDir }, { signal: input.signal });
      checkAbort(input);
      if (result.status === 'current') continue;
      store.transitionCandidate(candidate.id, candidate.version, 'conflict');
      invalidated.push(candidate.id);
    }
    return { invalidated };
  });
}

export async function reconcileConfiguredKnowledge(input: KnowledgeRuntimeOptions & { scope?: string }): Promise<{
  results: KnowledgePublicationResult[]; blocked: Array<BindingFailure | { key: string; code: 'publication_recovery_blocked' | 'experience_projection_blocked' }>;
}> {
  if (input.scope !== undefined) learningScopeSchema.parse(input.scope);
  checkAbort(input);
  await reconcileConfiguredLessons(input);
  const loaded = loadBindings(input.config);
  const results: KnowledgePublicationResult[] = [];
  const blocked: Array<BindingFailure | { key: string; code: 'publication_recovery_blocked' | 'experience_projection_blocked' }> = [...loaded.blocked];
  if (!existsSync(input.file)) return { results, blocked };
  await withStore(input, async store => {
    for (const binding of loaded.bindings) {
      if (input.scope !== undefined && binding.policy.scope !== input.scope) continue;
      const result = await reconcileKnowledgePublications({ ...binding, store, wikiScript: input.config.wikiScript,
        recoveryDirectory: input.recoveryDirectory, validationConfigurationFile: input.validationConfigurationFile, homeDir: input.homeDir, signal: input.signal });
      results.push(...result.results);
      blocked.push(...result.blocked);
    }
    const observed = new Set([...results.map(result => result.publication.key),
      ...blocked.flatMap(failure => 'key' in failure ? [failure.key] : [])]);
    for (const publication of store.listPublications()) {
      const candidate = store.getCandidate(publication.candidateId);
      if (observed.has(publication.key) || !candidate || !['fact', 'process', 'lesson'].includes(candidate.proposal.kind)
        || (input.scope !== undefined && candidate.proposal.applicability.project !== input.scope)) continue;
      if (publication.phase === 'superseded') {
        const binding = loaded.bindings.find(entry => entry.policy.scope === candidate.proposal.applicability.project
          && entry.policy.targets.some(target => target.ref === publication.targetRef));
        if (binding) {
          try {
            const successor = resolveKnowledgePublication({ ...binding, store, key: publication.key,
              wikiScript: input.config.wikiScript, recoveryDirectory: input.recoveryDirectory,
              validationConfigurationFile: input.validationConfigurationFile, homeDir: input.homeDir, signal: input.signal });
            if (observed.has(successor.key)) continue;
          } catch { checkAbort(input); }
        }
      }
      blocked.push({ key: publication.key, code: 'publication_recovery_blocked' });
    }
  });
  const projectionBlocked = await projectConfiguredLessons(input, results.filter(result => !result.withdrawal).map(result => result.publication.key));
  blocked.push(...projectionBlocked.map(key => ({ key, code: 'experience_projection_blocked' as const })));
  return { results, blocked };
}

function knowledgeScore(proposal: CandidateProposal, query: Set<string>, prompt: string): number {
  let body: string[];
  switch (proposal.kind) {
    case 'fact': body = [proposal.payload.subject, proposal.payload.rule]; break;
    case 'process': body = [proposal.payload.entry, ...proposal.payload.systems, ...proposal.payload.preconditions,
      ...proposal.payload.steps.flatMap(step => [step.action, step.stateChange]), ...proposal.payload.exceptions, proposal.payload.completion]; break;
    case 'lesson': body = [proposal.payload.trigger, proposal.payload.rootCause, ...proposal.payload.attempts,
      proposal.payload.fix, ...proposal.payload.prevention]; break;
    default: return 0;
  }
  const names = new Set([proposal.title, ...Array.from(proposal.statement.matchAll(/[（(](\p{Script=Han}{2,})[）)]/gu), match => match[1]!)]);
  const terms = recallTerms([proposal.title, proposal.statement, ...body, ...proposal.applicability.preconditions,
    ...proposal.applicability.exclusions, ...proposal.applicability.invalidationConditions].join(' '));
  let score = 0;
  for (const term of query) if (terms.has(term)) score++;
  for (const name of names) {
    if (/^\p{Script=Han}{2,}$/u.test(name) && !query.has(name) && prompt.includes(name)) score++;
  }
  if (!score && proposal.kind === 'process') {
    const previous = new Set<string>();
    for (const { action } of proposal.payload.steps) {
      const pairs = Array.from(action.matchAll(/(?=(\p{Script=Han}{2}))/gu), match => match[1]!)
        .filter(pair => prompt.includes(pair));
      if (pairs.some(pair => previous.size > 1 || (previous.size === 1 && !previous.has(pair)))) return 1;
      for (const pair of pairs) previous.add(pair);
    }
  }
  return score;
}

export class KnowledgeContextProvider implements ContextSource {
  readonly id = 'context.knowledge';
  readonly capabilities = { 'read-only': true, summarize: false, search: true } as const;

  constructor(private readonly options: KnowledgeRuntimeOptions) {}

  async gather(query: ContextQuery, operation?: ProviderOperationOptions): Promise<readonly ContextFragment[]> {
    const signals = [operation?.signal, this.options.signal].filter((signal): signal is AbortSignal => signal !== undefined);
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    checkAbort({ signal });
    learningScopeSchema.parse(query.scope);
    if ((query.target && !Object.hasOwn(query, 'target')) || (query.applicability && !Object.hasOwn(query, 'applicability'))) return [];
    if (query.target && query.target.project !== query.scope) return [];
    const limit = z.number().int().min(0).max(20).parse(query.limit ?? 5);
    if (!limit || !existsSync(this.options.file)) return [];
    const terms = recallTerms(query.prompt);
    if (!terms.size && !/\p{Script=Han}{2}/u.test(query.prompt)) return [];
    try {
      return await withStore({ ...this.options, signal }, async store => {
        const fragments: ContextFragment[] = [];
        const { bindings } = loadBindings(this.options.config);
        let bytes = 0;
        const ranked = store.listPublications().flatMap(publication => {
          checkAbort({ signal });
          if (publication.phase !== 'committed') return [];
          try { sourceReadCheck(this.options.config.sourceReadGrantFile, query.scope, publication)?.(); }
          catch { return []; }
          const candidate = store.getCandidate(publication.candidateId);
          if (!candidate || candidate.state !== 'published' || candidate.proposal.applicability.project !== query.scope) return [];
          const score = knowledgeScore(candidate.proposal, terms, query.prompt);
          return score ? [{ publication, score }] : [];
        }).sort((left, right) => right.score - left.score || left.publication.key.localeCompare(right.publication.key));
        for (const { publication } of ranked) {
          checkAbort({ signal });
          const binding = bindings.find(entry => entry.policy.scope === query.scope && entry.policy.targets.some(target => target.ref === publication.targetRef));
          if (!binding) continue;
          const knowledge = await readPublishedKnowledge({ ...binding, store, key: publication.key,
            sourceReadGrantFile: this.options.config.sourceReadGrantFile,
            wikiScript: this.options.config.wikiScript, recoveryDirectory: this.options.recoveryDirectory, signal,
            validationConfigurationFile: this.options.validationConfigurationFile, homeDir: this.options.homeDir,
            applicability: query.applicability, target: query.target });
          checkAbort({ signal });
          if (!knowledge || bytes + Buffer.byteLength(knowledge.content, 'utf8') > 8000) continue;
          bytes += Buffer.byteLength(knowledge.content, 'utf8');
          fragments.push({ origin: `knowledge:${publication.key}; target:${publication.targetRef}`, content: knowledge.content });
          if (fragments.length >= limit) break;
        }
        return fragments;
      });
    } catch { checkAbort({ signal }); return []; }
  }
}
