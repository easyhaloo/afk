import { z } from 'zod';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseWorkItemId } from '../../domain/work-item/identity.js';
import { checkAbort } from '../../infrastructure/providers/dependencies.js';
import type { AgentProvider } from '../../domain/agents/types.js';
import type { PluginManifest } from '../../plugin-sdk/profile.js';
import { DISTILLATION_LIMITS, distillationRequestSchema, learningScopeSchema, LearningReviewIncompleteError, normalizeLearningActionInput } from '../learning/contracts.js';
import { validateEvidencePack } from '../learning/evidence.js';
import { LearningWorker, learningDirectory, learningReplayTargetSchema, queryLearningRequest, queryLearningState, queryProposalValidationReceipt, submitDistillation, submitLearningReplay } from '../learning/worker.js';
import { CandidateStore } from '../learning/candidate-store.js';
import { proposalArtifactInputSchema } from '../learning/proposal-validation.js';
import { assertCurrentKnowledgePublication } from '../learning/knowledge-publication-guard.js';
import { verifyLessonPublication } from '../learning/lesson-publication-guard.js';
import { reconcileDistillationSources, submitLearningCorrection, type ReconcileDistillationOptions } from '../learning/intake.js';
import { learningDigestSchema, learningIdentitySchema } from '../learning/requests.js';
import { experienceQueryContextSchema } from '../learning/experience-store.js';
import { validateConfiguredLearningCandidate } from '../learning/validation-runtime.js';
import type { LearningValidationResult } from '../learning/validation.js';
import { readValidationPrivateFile } from '../learning/validation-files.js';
import { selectKnowledgeValidationChecker, validationConfigurationSchema } from '../learning/validation-configuration.js';
import type { RepositoryProvider, VerificationProvider } from '../../plugin-sdk/capabilities.js';
import { KnowledgeContextProvider, knowledgeConfigurationSchema, prepareConfiguredKnowledge, publishConfiguredKnowledge,
  reconcileConfiguredKnowledge, reconcileConfiguredLessons } from '../learning/knowledge-runtime.js';
import type { Plugin, PluginSystemAction, PluginSystemActionOptions } from './runtime.js';

export const learningConfigurationSchema = z.object({
  enabled: z.boolean().default(false), provider: z.string().regex(/^[a-z][a-z0-9.-]*$/).default('claude-code'),
  dailyCalls: z.number().int().nonnegative().max(10000).default(DISTILLATION_LIMITS.dailyCalls),
  timeoutMs: z.number().int().positive().max(DISTILLATION_LIMITS.timeoutMs).default(DISTILLATION_LIMITS.timeoutMs),
  knowledge: knowledgeConfigurationSchema.optional(),
  validation: z.object({ configurationFile: z.string().min(1).max(4096)
    .refine(value => isAbsolute(value) && resolve(value) === value && !/[\0\r\n]/.test(value)) }).strict().optional(),
  executionContexts: z.array(experienceQueryContextSchema).max(64).default([]).superRefine((contexts, validation) => {
    const projects = new Set<string>();
    for (const [index, context] of contexts.entries()) {
      const target = context.target;
      if (!target || !learningScopeSchema.safeParse(target.project).success || projects.has(target.project)
        || target.revision !== undefined || target.dirty !== undefined) {
        validation.addIssue({ code: 'custom', path: [index], message: 'Execution contexts require a unique canonical project and cannot configure Git revision or dirty state' });
      }
      if (target) projects.add(target.project);
    }
  }),
}).strict();
export type LearningConfiguration = z.infer<typeof learningConfigurationSchema>;

export const learningPluginManifest: PluginManifest = {
  id: 'learning.distiller', version: '0.2.0', apiVersion: 1,
  provides: ['workflow.action'], trusted: true,
  configSchema: { type: 'object', additionalProperties: false, properties: {
    enabled: { type: 'boolean', default: false }, provider: { type: 'string', default: 'claude-code', pattern: '^[a-z][a-z0-9.-]*$' },
    dailyCalls: { type: 'integer', default: 20, minimum: 0, maximum: 10000 },
    timeoutMs: { type: 'integer', default: 120000, minimum: 1, maximum: 120000 },
    knowledge: { type: 'object', additionalProperties: false, required: ['wikiScript', 'grants'], properties: {
      wikiScript: { type: 'string', minLength: 1, maxLength: 4096 },
      sourceReadGrantFile: { type: 'string', minLength: 1, maxLength: 4096 },
      grants: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 4096 } },
    } },
    validation: { type: 'object', additionalProperties: false, required: ['configurationFile'], properties: {
      configurationFile: { type: 'string', minLength: 1, maxLength: 4096 },
    } },
    executionContexts: { type: 'array', maxItems: 64, items: { type: 'object', additionalProperties: false, required: ['target'], properties: {
      applicability: { type: 'object', additionalProperties: false, properties: {
        version: { type: 'string', minLength: 1, maxLength: 512 }, environment: { type: 'string', minLength: 1, maxLength: 512 },
      } },
      target: { type: 'object', additionalProperties: false, required: ['project'], properties: {
        project: { type: 'string', minLength: 1, maxLength: 512 },
        productVersions: { type: 'object', additionalProperties: { type: 'string', minLength: 1, maxLength: 512 } },
        runtimeVersions: { type: 'object', additionalProperties: { type: 'string', minLength: 1, maxLength: 512 } },
        conditions: { type: 'object', additionalProperties: { type: 'boolean' } },
      } },
    } } },
  } },
};

export function createLearningPlugin(options: { homeDir?: string; config?: unknown } = {}): Plugin {
  const config = learningConfigurationSchema.parse(options.config ?? {});
  const directory = learningDirectory(options.homeDir);
  const lifetime = new AbortController();
  let resolveProvider: (() => AgentProvider | undefined) | undefined;
  const workers = new Set<LearningWorker>();
  const captureFailures = new Map<string, { root: string; runId: string; code: string }>();
  const publicationFailures = new Set<string>();
  const knowledge = config.knowledge && { config: config.knowledge, file: join(directory, 'candidates.sqlite'),
    recoveryDirectory: join(directory, 'publications'), validationConfigurationFile: config.validation?.configurationFile, homeDir: options.homeDir, signal: lifetime.signal };
  const reconcileKnowledge = async (scope?: string) => {
    if (!knowledge) return { results: [], blocked: [] };
    try {
      const result = await reconcileConfiguredKnowledge({ ...knowledge, scope });
      publicationFailures.delete('configuration');
      for (const key of publicationFailures) if (key.startsWith('grant:')) publicationFailures.delete(key);
      for (const entry of result.results) publicationFailures.delete(entry.publication.key);
      for (const failure of result.blocked) publicationFailures.add('key' in failure ? failure.key : `grant:${failure.grantIndex}`);
      return result;
    } catch {
      checkAbort({ signal: lifetime.signal });
      publicationFailures.add('configuration');
      return { results: [], blocked: [{ code: 'knowledge_configuration_unavailable' }] };
    }
  };
  const eventRootSchema = z.string().min(1).max(4096).refine(isAbsolute).optional();
  const captureSources = async (input: Omit<ReconcileDistillationOptions, 'directory' | 'homeDir'> = {}) => {
    const reconciliation = await reconcileDistillationSources({ directory, homeDir: options.homeDir, ...input });
    const root = resolve(input.eventRoot ?? process.env.AFK_EVENT_STORE_DIR ?? join(options.homeDir ?? homedir(), '.afk', 'events'));
    for (const source of reconciliation.checkedSources) {
      captureFailures.delete(JSON.stringify([source.eventRoot, source.runId]));
    }
    for (const failure of reconciliation.blocked) {
      const sourceRoot = failure.eventRoot ?? root;
      captureFailures.set(JSON.stringify([sourceRoot, failure.runId]), { ...failure, root: sourceRoot });
    }
    return reconciliation;
  };
  const reconcile = async (input: { scope?: string; runId?: string; eventRoot?: string } = {}) => {
    const reconciliation = await captureSources(input);
    await reconcileConfiguredLessons({ file: join(directory, 'candidates.sqlite'), recoveryDirectory: join(directory, 'publications'),
      validationConfigurationFile: config.validation?.configurationFile, homeDir: options.homeDir, scope: input.scope, signal: lifetime.signal });
    await reconcileKnowledge(input.scope);
    return reconciliation;
  };
  const assertEnabled = () => {
    if (!config.enabled) throw new Error('learning_disabled');
    if (lifetime.signal.aborted) throw new Error('learning_plugin_closed');
  };
  const withOperation = async <Result>(operation: PluginSystemActionOptions | undefined,
    action: (signal: AbortSignal) => Promise<Result>): Promise<Result> => {
    const controller = new AbortController();
    const abort = () => controller.abort(operation?.signal?.reason);
    operation?.signal?.addEventListener('abort', abort, { once: true });
    if (operation?.signal?.aborted) abort();
    const signal = AbortSignal.any([lifetime.signal, controller.signal]);
    try {
      checkAbort({ ...operation, signal });
      return await action(signal);
    } finally { operation?.signal?.removeEventListener('abort', abort); }
  };
  return {
    manifest: knowledge ? { ...learningPluginManifest, provides: [...learningPluginManifest.provides, 'context.provider'] } : learningPluginManifest,
    activate(context) {
      const registerAction = (name: string, action: PluginSystemAction) => {
        context.registerSystemAction(name, (input, operation) => {
          return action(normalizeLearningActionInput(name, input), operation);
        });
      };
      resolveProvider = () => context.getProvider<AgentProvider>('agent.provider', config.provider);
      if (knowledge) context.registerContextProvider('context.knowledge', new KnowledgeContextProvider(knowledge));
      context.onDispose(async () => {
        lifetime.abort(new Error('learning_plugin_closed'));
        await Promise.all([...workers].map(worker => worker.close()));
        workers.clear();
        resolveProvider = undefined;
      });
      registerAction('learning.settings', input => {
        z.object({}).strict().parse(input);
        return learningConfigurationSchema.parse(config);
      });
      registerAction('learning.context', input => {
        const { scope } = z.object({ scope: learningScopeSchema }).strict().parse(input);
        return experienceQueryContextSchema.parse(config.executionContexts.find(entry => entry.target?.project === scope) ?? {});
      });
      registerAction('learning.distill', async input => {
        assertEnabled();
        const parsed = z.object({ request: distillationRequestSchema, pack: z.unknown() }).strict().parse(input);
        return submitDistillation({ directory, request: parsed.request, pack: validateEvidencePack(parsed.pack) });
      });
      registerAction('learning.replay', input => {
        assertEnabled();
        return submitLearningReplay({ directory, ...learningReplayTargetSchema.parse(input) });
      });
      registerAction('learning.correct', async input => {
        assertEnabled();
        const parsed = z.object({ scope: learningScopeSchema, candidateId: learningDigestSchema,
          expectedVersion: z.number().int().positive().safe(), correction: z.string() }).strict().parse(input);
        const submitted = await submitLearningCorrection({ directory, scope: parsed.scope, sourceId: `candidate:${parsed.candidateId}`,
          correction: parsed.correction, target: { candidateId: parsed.candidateId, expectedVersion: parsed.expectedVersion } });
        return { jobId: submitted.key, scope: parsed.scope, candidateId: parsed.candidateId, candidateVersion: parsed.expectedVersion };
      });
      registerAction('learning.capture', async input => {
        assertEnabled();
        return reconcile(z.object({ scope: learningScopeSchema, runId: learningIdentitySchema, eventRoot: eventRootSchema }).strict().parse(input));
      });
      registerAction('learning.reconcile', async input => {
        assertEnabled();
        return reconcile(z.object({ scope: learningScopeSchema.optional(), runId: learningIdentitySchema.optional(), eventRoot: eventRootSchema }).strict().parse(input));
      });
      registerAction('learning.jobs', input => {
        const parsed = z.object({ scope: learningScopeSchema }).strict().parse(input);
        return queryLearningState({ directory, scope: parsed.scope }).jobs;
      });
      registerAction('learning.candidates', input => {
        const parsed = z.object({ scope: learningScopeSchema }).strict().parse(input);
        return queryLearningState({ directory, scope: parsed.scope }).candidates;
      });
      registerAction('learning.proposal.receipt', input => {
        const parsed = z.object({ scope: learningScopeSchema, candidateId: learningDigestSchema,
          artifact: proposalArtifactInputSchema.optional() }).strict().parse(input);
        return queryProposalValidationReceipt({ directory, ...parsed });
      });
      registerAction('learning.request', input => {
        const parsed = z.object({ scope: learningScopeSchema, requestKey: learningDigestSchema }).strict().parse(input);
        return queryLearningRequest({ directory, ...parsed });
      });
      registerAction('learning.knowledge.prepare', async input => {
        assertEnabled();
        if (!knowledge) throw new Error('knowledge_not_configured');
        const parsed = z.object({ scope: learningScopeSchema, candidateId: learningDigestSchema,
          expectedVersion: z.number().int().positive().safe(), targetRef: z.string().min(1).max(512).optional() }).strict().parse(input);
        return prepareConfiguredKnowledge({ ...knowledge, ...parsed });
      });
      registerAction('learning.validate', async input => {
        assertEnabled();
        if (!config.validation) throw new Error('validation_not_configured');
        return validateConfiguredLearningCandidate(input, { file: join(directory, 'candidates.sqlite'),
          homeDir: options.homeDir,
          configurationFile: config.validation.configurationFile, timeoutMs: config.timeoutMs, signal: lifetime.signal,
          resolveProvider: async binding => context.getProvider<VerificationProvider>('verification.provider', binding.providerId),
          proposal: { resolveRepository: async binding => context.getProvider<RepositoryProvider>('repository.provider', binding.providerId) } });
      });
      registerAction('learning.knowledge.publish', async input => {
        assertEnabled();
        if (!knowledge) throw new Error('knowledge_not_configured');
        const parsed = z.object({ scope: learningScopeSchema, key: learningDigestSchema }).strict().parse(input);
        return publishConfiguredKnowledge({ ...knowledge, ...parsed });
      });
      registerAction('learning.knowledge.reconcile', async input => {
        assertEnabled();
        const parsed = z.object({ scope: learningScopeSchema.optional() }).strict().parse(input);
        return reconcileKnowledge(parsed.scope);
      });
      const runWorker = (input: unknown, operation: PluginSystemActionOptions | undefined, watch: boolean) => withOperation(operation, async signal => {
        assertEnabled();
        const check = () => { assertEnabled(); checkAbort({ ...operation, signal }); };
        check();
        const empty = z.object({}).strict();
        if (watch) empty.parse(input);
        const target = watch ? undefined : z.union([z.object({ scope: learningScopeSchema, requestKey: learningDigestSchema }).strict(),
          empty.transform(() => undefined)]).parse(input);
        const provider = resolveProvider?.();
        if (!provider?.capabilities.has('analysis') || provider.name !== 'claude-code') throw new Error('analysis_unsupported');
        const worker = new LearningWorker({ directory, ...config, provider, reconcileSources: async selected => {
          check();
          if (!selected) { await reconcile(); return; }
          const state = queryLearningRequest({ directory, ...selected });
          if (state.job.sourceRunId) await captureSources({ scope: selected.scope, runId: state.job.sourceRunId });
          check();
        } });
        workers.add(worker);
        const cancel = () => { void worker.close().catch(() => {}); };
        signal.addEventListener('abort', cancel, { once: true });
        try {
          check();
          if (watch) {
            await worker.watch(signal);
            assertEnabled();
            if (!signal.aborted) throw new Error('learning_worker_stopped_unexpectedly');
            return { status: 'stopped' };
          }
          const result = target ? await worker.runOnce(target) : await worker.runOnce();
          check();
          return result;
        } finally { signal.removeEventListener('abort', cancel); workers.delete(worker); await worker.close(); }
      });
      registerAction('learning.worker.once', (input, operation) => runWorker(input, operation, false));
      context.registerSystemAction('learning.worker.watch', (input, operation) => runWorker(input, operation, true));
      registerAction('learning.retrospective', async (input, operation) => withOperation(operation, async signal => {
        assertEnabled();
        const check = () => { assertEnabled(); checkAbort({ ...operation, signal }); };
        check();
        const parsed = z.object({ scope: learningScopeSchema, runId: learningIdentitySchema,
          kind: z.enum(['process', 'lesson', 'skill', 'tool']), checkerId: learningIdentitySchema, workItemId: z.string().optional(),
          repair: z.literal(true).optional() }).strict().parse(input);
        const { kind } = parsed;
        const candidateKind = kind === 'skill' || kind === 'tool' ? kind : undefined;
        const proposalKind = candidateKind !== undefined;
        let repairRoot: string | undefined;
        if (!proposalKind && !knowledge) throw new Error('knowledge_not_configured');
        if (!config.validation) throw new Error('validation_not_configured');
        if (parsed.repair) {
          if (parsed.kind !== 'lesson' || !parsed.workItemId) throw new Error('repair_source_identity_required');
          const saved = validationConfigurationSchema.parse(JSON.parse(readValidationPrivateFile(config.validation.configurationFile).bytes.toString('utf8')));
          const checker = selectKnowledgeValidationChecker(saved, parsed.scope, parsed.checkerId);
          const qa = checker && 'qa' in checker ? checker.qa : undefined;
          if (!qa?.repair || qa.scope !== parsed.scope || qa.workItemId !== parsed.workItemId
            || qa.repair.failure.runId !== parsed.runId
            || new Set([qa.repair.failure.runId, qa.repair.fix.runId, qa.runId]).size !== 3) throw new Error('repair_checker_unavailable');
          repairRoot = qa.repair.failure.root;
        }
        const source = { scope: parsed.scope, runId: parsed.runId, retryAnalysis: true,
          ...(candidateKind ? { candidateKind } : {}),
          ...(parsed.repair ? { includeFailed: true, eventRoot: repairRoot } : {}),
          ...(parsed.workItemId === undefined ? {} : { workItemId: parseWorkItemId(parsed.workItemId).id }) };
        const capture = await captureSources(source);
        check();
        if (capture.blocked.length) throw new Error('learning_capture_blocked');
        if (capture.requestKeys.length !== 1) throw new Error(capture.requestKeys.length ? 'learning_request_ambiguous' : 'learning_request_unavailable');
        const target = { scope: parsed.scope, requestKey: capture.requestKeys[0]! };
        let state = queryLearningRequest({ directory, ...target });
        if (state.job.sourceRunId !== parsed.runId || source.workItemId !== undefined && state.job.workItemId !== source.workItemId) throw new Error('learning_source_mismatch');
        if (!state.processing) {
          const provider = resolveProvider?.();
          if (!provider?.capabilities.has('analysis') || provider.name !== 'claude-code') throw new Error('analysis_unsupported');
          const worker = new LearningWorker({ directory, ...config, provider,
            reconcileSources: async () => {
              check();
              const current = await captureSources(source);
              check();
              if (current.blocked.length || current.requestKeys.length !== 1 || current.requestKeys[0] !== target.requestKey) throw new Error('learning_capture_blocked');
            } });
          workers.add(worker);
          const cancel = () => { void worker.close().catch(() => {}); };
          signal.addEventListener('abort', cancel, { once: true });
          try { check(); state = await worker.runOnce(target); }
          finally { signal.removeEventListener('abort', cancel); workers.delete(worker); await worker.close(); }
        }
        check();
        if (!state.processing || state.job.status !== 'processed' || state.job.reasonCode) throw new Error('learning_request_blocked');
        const candidates = state.candidates.filter(candidate => candidate.proposal.kind === parsed.kind);
        if (!candidates.length) throw new Error('learning_candidates_unavailable');
        if (proposalKind) for (const candidate of candidates) {
          if (candidate.state === 'validated') throw new Error('learning_proposal_revalidation_required');
          if (candidate.state !== 'candidate') throw new Error('learning_candidate_not_preparable');
        }
        const prepared = [];
        const validated: Extract<LearningValidationResult, { status: 'validated' }>[] = [];
        for (const candidate of candidates) {
          let blocked = false;
          try {
            check();
            let validatedVersion: number;
            if (candidate.state === 'candidate') {
              const validation = await validateConfiguredLearningCandidate({ scope: parsed.scope, candidateId: candidate.id,
                expectedVersion: candidate.version, checkerId: parsed.checkerId }, { file: join(directory, 'candidates.sqlite'),
                homeDir: options.homeDir, configurationFile: config.validation.configurationFile,
                timeoutMs: config.timeoutMs, ...operation, signal,
                resolveProvider: async binding => context.getProvider<VerificationProvider>('verification.provider', binding.providerId),
                proposal: { resolveRepository: async binding => context.getProvider<RepositoryProvider>('repository.provider', binding.providerId) } });
              if (validation.status === 'validated' && proposalKind) validated.push(validation);
              check();
              if (validation.status !== 'validated') {
                blocked = true;
                throw new Error(`learning_validation_${validation.code}`);
              }
              if (proposalKind) continue;
              validatedVersion = validation.validatedVersion;
            } else if (candidate.state === 'validated') {
              const store = new CandidateStore({ file: join(directory, 'candidates.sqlite') });
              try {
                const binding = { store, candidate, configurationFile: config.validation.configurationFile, homeDir: options.homeDir };
                if (parsed.kind === 'lesson') {
                  const current = verifyLessonPublication(binding, { ...operation, signal });
                  if (current.status !== 'current' || current.binding.checkerId !== parsed.checkerId) throw new Error('learning_validation_unavailable');
                  validatedVersion = current.binding.validatedVersion;
                } else {
                  assertCurrentKnowledgePublication({ ...binding, checkerId: parsed.checkerId }, { ...operation, signal });
                  validatedVersion = candidate.version;
                }
              } finally { store.close(); }
            } else throw new Error('learning_candidate_not_preparable');
            check();
            if (!knowledge) throw new Error('knowledge_not_configured');
            const publication = await prepareConfiguredKnowledge({ ...knowledge, signal, scope: parsed.scope, candidateId: candidate.id,
              expectedVersion: validatedVersion });
            check();
            prepared.push({ candidateId: candidate.id, validatedVersion, publication });
          } catch (error) {
            if (proposalKind && validated.length) throw new LearningReviewIncompleteError({
              status: 'incomplete', scope: parsed.scope, runId: parsed.runId, requestKey: target.requestKey,
              validated, interruptedCandidateId: candidate.id,
              reason: signal.aborted ? 'cancelled' : blocked ? 'validation_blocked' : 'validation_failed',
            }, { cause: error });
            throw error;
          }
        }
        return { scope: parsed.scope, runId: parsed.runId, requestKey: target.requestKey, processing: state.processing,
          ...(proposalKind ? { validated } : { prepared }) };
      }));
    },
    health: () => ({ status: config.enabled ? 'unknown' : 'degraded',
      message: config.enabled ? 'Analysis readiness is checked before each execution' : 'Learning is disabled' }),
    diagnostics: () => {
      const provider = resolveProvider?.();
      return [
        ...(config.enabled && (!provider?.capabilities.has('analysis') || provider.name !== 'claude-code')
          ? [{ severity: 'error' as const, code: 'analysis_unsupported', message: 'Selected provider does not support restricted analysis' }] : []),
        ...(captureFailures.size ? [{ severity: 'warning' as const, code: 'learning_capture_degraded',
          message: 'Some audit sources could not be reconciled; inspect learning.reconcile results' }] : []),
        ...(publicationFailures.size ? [{ severity: 'warning' as const, code: 'knowledge_publication_degraded',
          message: 'Some knowledge publications require recovery; inspect learning.knowledge.reconcile results' }] : []),
      ];
    },
  };
}
