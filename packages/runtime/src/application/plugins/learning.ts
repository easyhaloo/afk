import { z } from 'zod';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { checkAbort } from '../../infrastructure/providers/dependencies.js';
import type { AgentProvider } from '../../domain/agents/types.js';
import type { PluginManifest } from '../../plugin-sdk/profile.js';
import { DISTILLATION_LIMITS, distillationRequestSchema, learningScopeSchema } from '../learning/contracts.js';
import { validateEvidencePack } from '../learning/evidence.js';
import { LearningWorker, learningDirectory, queryLearningState, submitDistillation } from '../learning/worker.js';
import { reconcileDistillationSources } from '../learning/intake.js';
import { learningDigestSchema, learningIdentitySchema } from '../learning/requests.js';
import { experienceQueryContextSchema } from '../learning/experience-store.js';
import { validateConfiguredLearningCandidate } from '../learning/validation-runtime.js';
import type { VerificationProvider } from '../../plugin-sdk/capabilities.js';
import { KnowledgeContextProvider, knowledgeConfigurationSchema, prepareConfiguredKnowledge, publishConfiguredKnowledge,
  reconcileConfiguredKnowledge, reconcileConfiguredLessons } from '../learning/knowledge-runtime.js';
import type { Plugin } from './runtime.js';

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
    recoveryDirectory: join(directory, 'publications'), validationConfigurationFile: config.validation?.configurationFile, signal: lifetime.signal };
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
  const reconcile = async (input: { scope?: string; runId?: string; eventRoot?: string } = {}) => {
    const reconciliation = await reconcileDistillationSources({ directory, homeDir: options.homeDir, ...input });
    await reconcileConfiguredLessons({ file: join(directory, 'candidates.sqlite'), recoveryDirectory: join(directory, 'publications'),
      validationConfigurationFile: config.validation?.configurationFile, scope: input.scope, signal: lifetime.signal });
    const root = resolve(input.eventRoot ?? process.env.AFK_EVENT_STORE_DIR ?? join(options.homeDir ?? homedir(), '.afk', 'events'));
    for (const source of reconciliation.checkedSources) {
      captureFailures.delete(JSON.stringify([source.eventRoot, source.runId]));
    }
    for (const failure of reconciliation.blocked) {
      const sourceRoot = failure.eventRoot ?? root;
      captureFailures.set(JSON.stringify([sourceRoot, failure.runId]), { ...failure, root: sourceRoot });
    }
    await reconcileKnowledge(input.scope);
    return reconciliation;
  };
  const assertEnabled = () => {
    if (!config.enabled) throw new Error('learning_disabled');
    if (lifetime.signal.aborted) throw new Error('learning_plugin_closed');
  };
  return {
    manifest: knowledge ? { ...learningPluginManifest, provides: [...learningPluginManifest.provides, 'context.provider'] } : learningPluginManifest,
    activate(context) {
      resolveProvider = () => context.getProvider<AgentProvider>('agent.provider', config.provider);
      if (knowledge) context.registerContextProvider('context.knowledge', new KnowledgeContextProvider(knowledge));
      context.onDispose(async () => {
        lifetime.abort(new Error('learning_plugin_closed'));
        await Promise.all([...workers].map(worker => worker.close()));
        workers.clear();
        resolveProvider = undefined;
      });
      context.registerSystemAction('learning.settings', input => {
        z.object({}).strict().parse(input);
        return learningConfigurationSchema.parse(config);
      });
      context.registerSystemAction('learning.context', input => {
        const { scope } = z.object({ scope: learningScopeSchema }).strict().parse(input);
        return experienceQueryContextSchema.parse(config.executionContexts.find(entry => entry.target?.project === scope) ?? {});
      });
      context.registerSystemAction('learning.distill', async input => {
        assertEnabled();
        const parsed = z.object({ request: distillationRequestSchema, pack: z.unknown() }).strict().parse(input);
        return submitDistillation({ directory, request: parsed.request, pack: validateEvidencePack(parsed.pack) });
      });
      context.registerSystemAction('learning.capture', async input => {
        assertEnabled();
        return reconcile(z.object({ scope: learningScopeSchema, runId: learningIdentitySchema, eventRoot: eventRootSchema }).strict().parse(input));
      });
      context.registerSystemAction('learning.reconcile', async input => {
        assertEnabled();
        return reconcile(z.object({ scope: learningScopeSchema.optional(), runId: learningIdentitySchema.optional(), eventRoot: eventRootSchema }).strict().parse(input));
      });
      context.registerSystemAction('learning.jobs', input => {
        const parsed = z.object({ scope: learningScopeSchema }).strict().parse(input);
        return queryLearningState({ directory, scope: parsed.scope }).jobs;
      });
      context.registerSystemAction('learning.candidates', input => {
        const parsed = z.object({ scope: learningScopeSchema }).strict().parse(input);
        return queryLearningState({ directory, scope: parsed.scope }).candidates;
      });
      context.registerSystemAction('learning.knowledge.prepare', async input => {
        assertEnabled();
        if (!knowledge) throw new Error('knowledge_not_configured');
        const parsed = z.object({ scope: learningScopeSchema, candidateId: learningDigestSchema,
          expectedVersion: z.number().int().positive().safe(), targetRef: z.string().min(1).max(512).optional() }).strict().parse(input);
        return prepareConfiguredKnowledge({ ...knowledge, ...parsed });
      });
      context.registerSystemAction('learning.validate', async input => {
        assertEnabled();
        if (!config.validation) throw new Error('validation_not_configured');
        return validateConfiguredLearningCandidate(input, { file: join(directory, 'candidates.sqlite'),
          configurationFile: config.validation.configurationFile, timeoutMs: config.timeoutMs, signal: lifetime.signal,
          resolveProvider: async binding => context.getProvider<VerificationProvider>('verification.provider', binding.providerId) });
      });
      context.registerSystemAction('learning.knowledge.publish', async input => {
        assertEnabled();
        if (!knowledge) throw new Error('knowledge_not_configured');
        const parsed = z.object({ scope: learningScopeSchema, key: learningDigestSchema }).strict().parse(input);
        return publishConfiguredKnowledge({ ...knowledge, ...parsed });
      });
      context.registerSystemAction('learning.knowledge.reconcile', async input => {
        assertEnabled();
        const parsed = z.object({ scope: learningScopeSchema.optional() }).strict().parse(input);
        return reconcileKnowledge(parsed.scope);
      });
      context.registerSystemAction('learning.worker.once', async input => {
        assertEnabled();
        z.object({}).strict().parse(input);
        const provider = resolveProvider?.();
        if (!provider?.capabilities.has('analysis') || provider.name !== 'claude-code') throw new Error('analysis_unsupported');
        const worker = new LearningWorker({ directory, ...config, provider, reconcileSources: async () => { await reconcile(); } });
        workers.add(worker);
        try { return await worker.runOnce(); }
        finally { workers.delete(worker); await worker.close(); }
      });
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
