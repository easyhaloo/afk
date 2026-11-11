import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { ContextFragment, ContextQuery, ContextSource, ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';
import { checkAbort } from '../../infrastructure/providers/dependencies.js';
import { CandidateStore } from './candidate-store.js';
import { learningScopeSchema } from './contracts.js';
import { readKnowledgeGrant, type KnowledgePolicy } from './knowledge.js';
import { prepareKnowledgePublication, publishLearningCandidate, readPublishedKnowledge, reconcileKnowledgePublications, resolveKnowledgePublication,
  type KnowledgePublicationResult, type PublicationOptions } from './publication.js';
import { learningDigestSchema } from './requests.js';

const savedPath = z.string().min(1).max(4096).refine(value => isAbsolute(value) && resolve(value) === value && !value.includes('\0'));
export const knowledgeConfigurationSchema = z.object({ wikiScript: savedPath,
  grants: z.array(savedPath).min(1).max(64).refine(values => new Set(values).size === values.length) }).strict();
export type KnowledgeConfiguration = z.infer<typeof knowledgeConfigurationSchema>;
export type KnowledgeRuntimeOptions = { file: string; recoveryDirectory: string; config: KnowledgeConfiguration; signal?: AbortSignal };
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
  return { ...matches[0]!, store, wikiScript: options.config.wikiScript, recoveryDirectory: options.recoveryDirectory, signal: options.signal };
}

async function withStore<Result>(options: KnowledgeRuntimeOptions, operation: (store: CandidateStore) => Promise<Result>): Promise<Result> {
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
  return withStore(input, async store => {
    const publication = store.getPublication(learningDigestSchema.parse(input.key));
    const candidate = publication && store.getCandidate(publication.candidateId);
    if (!candidate || candidate.proposal.applicability.project !== learningScopeSchema.parse(input.scope)) throw new Error('knowledge_candidate_scope_mismatch');
    return publishLearningCandidate({ ...route(input, store, input.scope, publication!.targetRef), key: input.key });
  });
}

export async function reconcileConfiguredKnowledge(input: KnowledgeRuntimeOptions & { scope?: string }): Promise<{
  results: KnowledgePublicationResult[]; blocked: Array<BindingFailure | { key: string; code: 'publication_recovery_blocked' }>;
}> {
  if (input.scope !== undefined) learningScopeSchema.parse(input.scope);
  checkAbort(input);
  const loaded = loadBindings(input.config);
  const results: KnowledgePublicationResult[] = [];
  const blocked: Array<BindingFailure | { key: string; code: 'publication_recovery_blocked' }> = [...loaded.blocked];
  if (!existsSync(input.file)) return { results, blocked };
  await withStore(input, async store => {
    for (const binding of loaded.bindings) {
      if (input.scope !== undefined && binding.policy.scope !== input.scope) continue;
      const result = await reconcileKnowledgePublications({ ...binding, store, wikiScript: input.config.wikiScript,
        recoveryDirectory: input.recoveryDirectory, signal: input.signal });
      results.push(...result.results);
      blocked.push(...result.blocked);
    }
    const observed = new Set([...results.map(result => result.publication.key),
      ...blocked.flatMap(failure => 'key' in failure ? [failure.key] : [])]);
    for (const publication of store.listPublications()) {
      const candidate = store.getCandidate(publication.candidateId);
      if (observed.has(publication.key) || !candidate || !['fact', 'process'].includes(candidate.proposal.kind)
        || (input.scope !== undefined && candidate.proposal.applicability.project !== input.scope)) continue;
      if (publication.phase === 'superseded') {
        const binding = loaded.bindings.find(entry => entry.policy.scope === candidate.proposal.applicability.project
          && entry.policy.targets.some(target => target.ref === publication.targetRef));
        if (binding) {
          try {
            const successor = resolveKnowledgePublication({ ...binding, store, key: publication.key,
              wikiScript: input.config.wikiScript, recoveryDirectory: input.recoveryDirectory, signal: input.signal });
            if (observed.has(successor.key)) continue;
          } catch { checkAbort(input); }
        }
      }
      blocked.push({ key: publication.key, code: 'publication_recovery_blocked' });
    }
  });
  return { results, blocked };
}

export class KnowledgeContextProvider implements ContextSource {
  readonly id = 'context.knowledge';
  readonly capabilities = { 'read-only': true, summarize: false, search: false } as const;

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
    try {
      return await withStore({ ...this.options, signal }, async store => {
        const fragments: ContextFragment[] = [];
        const { bindings } = loadBindings(this.options.config);
        let bytes = 0;
        for (const publication of store.listPublications()) {
          checkAbort({ signal });
          if (publication.phase === 'superseded') continue;
          const candidate = store.getCandidate(publication.candidateId);
          if (!candidate || candidate.proposal.applicability.project !== query.scope) continue;
          const binding = bindings.find(entry => entry.policy.scope === query.scope && entry.policy.targets.some(target => target.ref === publication.targetRef));
          if (!binding) continue;
          const knowledge = await readPublishedKnowledge({ ...binding, store, key: publication.key,
            wikiScript: this.options.config.wikiScript, recoveryDirectory: this.options.recoveryDirectory, signal,
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
