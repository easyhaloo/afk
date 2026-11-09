import { z } from 'zod';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { AgentProvider } from '../../domain/agents/types.js';
import type { PluginManifest } from '../../plugin-sdk/profile.js';
import { DISTILLATION_LIMITS, distillationRequestSchema, learningScopeSchema } from '../learning/contracts.js';
import { validateEvidencePack } from '../learning/evidence.js';
import { LearningWorker, learningDirectory, queryLearningState, submitDistillation } from '../learning/worker.js';
import { reconcileDistillationSources } from '../learning/intake.js';
import { learningIdentitySchema } from '../learning/requests.js';
import type { Plugin } from './runtime.js';

export const learningConfigurationSchema = z.object({
  enabled: z.boolean().default(false), provider: z.string().regex(/^[a-z][a-z0-9.-]*$/).default('claude-code'),
  dailyCalls: z.number().int().nonnegative().max(10000).default(DISTILLATION_LIMITS.dailyCalls),
  timeoutMs: z.number().int().positive().max(DISTILLATION_LIMITS.timeoutMs).default(DISTILLATION_LIMITS.timeoutMs),
}).strict();
export type LearningConfiguration = z.infer<typeof learningConfigurationSchema>;

export const learningPluginManifest: PluginManifest = {
  id: 'learning.distiller', version: '0.1.0', apiVersion: 1,
  provides: ['workflow.action'], trusted: true,
  configSchema: { type: 'object', additionalProperties: false, properties: {
    enabled: { type: 'boolean', default: false }, provider: { type: 'string', default: 'claude-code', pattern: '^[a-z][a-z0-9.-]*$' },
    dailyCalls: { type: 'integer', default: 20, minimum: 0, maximum: 10000 },
    timeoutMs: { type: 'integer', default: 120000, minimum: 1, maximum: 120000 },
  } },
};

export function createLearningPlugin(options: { homeDir?: string; config?: unknown } = {}): Plugin {
  const config = learningConfigurationSchema.parse(options.config ?? {});
  const directory = learningDirectory(options.homeDir);
  let resolveProvider: (() => AgentProvider | undefined) | undefined;
  const workers = new Set<LearningWorker>();
  const captureFailures = new Map<string, { root: string; runId: string; code: string }>();
  const eventRootSchema = z.string().min(1).max(4096).refine(isAbsolute).optional();
  const reconcile = async (input: { scope?: string; runId?: string; eventRoot?: string } = {}) => {
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
  const assertEnabled = () => { if (!config.enabled) throw new Error('learning_disabled'); };
  return {
    manifest: learningPluginManifest,
    activate(context) {
      resolveProvider = () => context.getProvider<AgentProvider>('agent.provider', config.provider);
      context.onDispose(async () => {
        await Promise.all([...workers].map(worker => worker.close()));
        workers.clear();
        resolveProvider = undefined;
      });
      context.registerSystemAction('learning.settings', input => {
        z.object({}).strict().parse(input);
        return { ...config };
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
      ];
    },
  };
}
