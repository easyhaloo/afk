import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import type { EvidenceRef, EvidenceStorePort } from '@afk/core';
import type {
  ArtifactDescriptor, ArtifactRef, ContextFragment, ContextQuery, NotificationMessage,
  PolicyCheckInput, VerificationRequest, VerificationResult,
} from '../../plugin-sdk/capabilities.js';
import type { LifecycleContext, LifecycleModule } from '../workflows/lifecycle.js';
import type { PluginRuntime, PluginSetupContext } from './runtime.js';
import { withCancellation } from './cancellation.js';
import {
  artifactRefSchema, contextFragmentsSchema, invokeCapability, notificationReceiptSchema, policyDecisionSchema, verificationRequestSchema, verificationResultSchema,
} from './operations.js';

type ContextValue<T> = (context: LifecycleContext) => T | Promise<T>;

export interface PublishedCapabilityArtifact {
  readonly provider: string;
  readonly artifact: ArtifactRef;
}

export interface CapabilityLifecycleSelection {
  readonly verificationEvidence?: EvidenceStorePort;
  readonly policies?: readonly { readonly provider: string; readonly input: ContextValue<PolicyCheckInput> }[];
  readonly verifications?: readonly { readonly provider: string; readonly request: ContextValue<VerificationRequest> }[];
  readonly contexts?: readonly {
    readonly provider: string;
    readonly query: ContextValue<ContextQuery>;
    readonly consume: (fragments: readonly ContextFragment[], context: LifecycleContext) => void | Promise<void>;
  }[];
  readonly artifacts?: readonly {
    readonly provider: string;
    readonly artifact: ContextValue<ArtifactDescriptor>;
    readonly publish: (artifact: ArtifactRef, context: LifecycleContext) => void | Promise<void>;
  }[];
  readonly notifications?: readonly {
    readonly provider: string;
    readonly message: (context: LifecycleContext, artifacts: readonly PublishedCapabilityArtifact[]) => NotificationMessage | Promise<NotificationMessage>;
  }[];
}

export function createCapabilityLifecycle(runtime: PluginRuntime, selection: CapabilityLifecycleSelection): LifecycleModule {
  const policies = [...selection.policies ?? []];
  const verifications = [...selection.verifications ?? []];
  const contexts = [...selection.contexts ?? []];
  const artifacts = [...selection.artifacts ?? []];
  const notifications = [...selection.notifications ?? []];
  const evaluatePolicies = async (context: LifecycleContext) => {
    for (const policy of policies) {
      const decision = policyDecisionSchema.parse(await invokeCapability(runtime, {
        capability: 'policy.provider', provider: policy.provider, operation: 'evaluate',
        input: await withCancellation(() => policy.input(context), context.signal ? { signal: context.signal } : undefined),
      }, context.signal ? { signal: context.signal } : undefined));
      if (!decision.allowed) throw new Error('Execution denied by capability policy');
    }
  };
  const verify = async (context: LifecycleContext, phase: 'after-agent' | 'before-publish') => {
    const store = selection.verificationEvidence;
    const observation = context.observation;
    if (store && verifications.length && !observation) throw new Error('Capability verification requires an observation context');
    for (const verification of verifications) {
      const executionId = randomUUID();
      const observationContext = observation ? structuredClone(observation.context) : undefined;
      const target = context.worktreePath;
      let workspace = target;
      const revision = async () => {
        if (await realpath(target) !== workspace) throw new Error('Capability verification workspace changed');
        const git = simpleGit(workspace);
        return { head: await git.revparse(['HEAD']), branch: await git.revparse(['--abbrev-ref', 'HEAD']) };
      };
      let before: Awaited<ReturnType<typeof revision>> | undefined;
      let after: typeof before;
      let result: VerificationResult | undefined;
      let classification = 'workspace-failed';
      const errors: unknown[] = [];
      const failures: { classification: string; message: string }[] = [];
      const fail = (kind: string, error: unknown) => {
        errors.push(error);
        failures.push({ classification: kind, message: error instanceof Error ? error.message : String(error) });
      };
      try {
        if (store) {
          workspace = await realpath(target);
          before = await revision();
          classification = 'audit-failed';
          await observation!.record({ kind: 'effect.started', effectKind: 'verification', idempotencyKey: executionId }, { idempotencyKey: executionId });
        }
        classification = 'invalid-request';
        const parsedRequest = verificationRequestSchema.safeParse({
          ...await withCancellation(() => verification.request(context), context.signal ? { signal: context.signal } : undefined),
          target: workspace, executionId,
        });
        if (!parsedRequest.success) throw new Error('Invalid or unsupported capability invocation; credential operations are private');
        const request = parsedRequest.data;
        classification = 'provider-exception';
        result = verificationResultSchema.parse(await invokeCapability(runtime, {
          capability: 'verification.provider', provider: verification.provider, operation: 'verify', input: request,
        }, { ...(context.signal ? { signal: context.signal } : {}), authorizedWorkspace: workspace }));
        classification = 'execution-mismatch';
        if (result.execution) {
          const execution = result.execution;
          if (execution.executionId !== executionId || execution.cwd !== await realpath(workspace)
            || execution.inputDigest !== createHash('sha256').update(request.input ?? '').digest('hex')
            || (request.command && JSON.stringify(execution.command) !== JSON.stringify(request.command))
            || result.passed !== (execution.exitCode === 0)) {
            throw new Error('Capability verification execution mismatch');
          }
        }
        classification = 'verification-failed';
        if (!result.passed) throw new Error('Capability verification failed');
        await withCancellation(() => undefined, context.signal ? { signal: context.signal } : undefined);
      } catch (error) {
        fail(context.signal?.aborted ? 'cancelled' : classification, error);
      }
      if (store) {
        if (before) {
          try {
            after = await revision();
            if (before.head !== after.head || before.branch !== after.branch) {
              throw new Error('Capability verification HEAD or branch changed');
            }
          } catch (error) { fail('revision-changed', error); }
        }
        if (context.signal?.aborted && !failures.some(failure => failure.classification === 'cancelled')) {
          fail('cancelled', context.signal.reason ?? new Error('Capability verification cancelled'));
        }
        let ref: EvidenceRef | undefined;
        try {
          ref = await store.put({
            bytes: Buffer.from(JSON.stringify({
              protocol: 'capability-verification-v1', provider: verification.provider, executionId,
              observation: observationContext, phase, workspace, revision: { before, after },
              provenance: result?.execution ? 'provider-result' : 'provider-reported', result,
              outcome: errors.length ? 'failed' : 'succeeded', failures,
            })),
            mediaType: 'application/json', classification: 'sensitive', redactionStatus: 'not_required',
          });
        } catch (error) { fail('persistence-failed', error); }
        try {
          await observation!.record({
            kind: 'effect.completed', effectKind: 'verification', idempotencyKey: executionId,
            outcome: errors.length ? 'failed' : 'succeeded',
            ...(failures.length ? { summary: JSON.stringify(failures) } : {}),
          }, { idempotencyKey: executionId, ...(ref ? { evidence: [ref] } : {}) });
        } catch (error) { fail('audit-failed', error); }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, 'Capability verification failed to verify, persist or audit');
    }
  };
  return {
    name: 'capability-integrations',
    order: -100,
    failureMode: 'required',
    async onBeforePublish(context) {
      await evaluatePolicies(context);
      await verify(context, 'before-publish');
    },
    async onBeforeAgent(context) {
      await evaluatePolicies(context);
      for (const source of contexts) {
        const fragments = contextFragmentsSchema.parse(await invokeCapability(runtime, {
          capability: 'context.provider', provider: source.provider, operation: 'gather',
          input: await withCancellation(() => source.query(context), context.signal ? { signal: context.signal } : undefined),
        }, context.signal ? { signal: context.signal } : undefined));
        await withCancellation(() => source.consume(fragments, context), context.signal ? { signal: context.signal } : undefined);
      }
    },
    async onAfterAgent(context) {
      await evaluatePolicies(context);
      await verify(context, 'after-agent');
      const published: PublishedCapabilityArtifact[] = [];
      for (const sink of artifacts) {
        const descriptor = await withCancellation(() => sink.artifact(context), context.signal ? { signal: context.signal } : undefined);
        const artifact = artifactRefSchema.parse(await invokeCapability(runtime, {
          capability: 'artifact.provider', provider: sink.provider, operation: 'put',
          input: { ...descriptor, bytes: Buffer.from(descriptor.bytes).toString('base64') },
        }, context.signal ? { signal: context.signal } : undefined));
        await withCancellation(() => sink.publish(artifact, context), context.signal ? { signal: context.signal } : undefined);
        published.push({ provider: sink.provider, artifact });
      }
      for (const notification of notifications) {
        const observation = context.observation;
        const executionId = randomUUID();
        const idempotencyKey = `notification:${encodeURIComponent(notification.provider)}:${executionId}`;
        let result: { delivered: boolean; channelDigest: string } | undefined;
        let classification = 'audit-failed';
        const failures: string[] = [];
        try {
          await observation?.record({ kind: 'effect.started', effectKind: 'notification', idempotencyKey }, { idempotencyKey });
          classification = 'message-failed';
          const message = await withCancellation(() => notification.message(context, published), context.signal ? { signal: context.signal } : undefined);
          classification = 'provider-missing';
          if (!runtime.getNotificationProvider(notification.provider)) throw new Error('Capability notification provider is not registered');
          classification = 'provider-failed';
          const receipt = notificationReceiptSchema.parse(await invokeCapability(runtime, {
            capability: 'notification.provider', provider: notification.provider, operation: 'notify', input: message,
          }, context.signal ? { signal: context.signal } : undefined));
          result = { delivered: receipt.delivered, channelDigest: createHash('sha256').update(receipt.channel).digest('hex') };
          classification = 'not-delivered';
          if (!receipt.delivered) throw new Error('Capability notification was not delivered');
        } catch {
          failures.push(context.signal?.aborted && classification !== 'audit-failed' ? 'cancelled' : classification);
        }
        if (context.signal?.aborted && !failures.includes('cancelled')) failures.push('cancelled');
        try {
          await observation?.record({
            kind: 'effect.completed', effectKind: 'notification', idempotencyKey,
            outcome: failures.length ? 'failed' : 'succeeded',
            summary: JSON.stringify({
              protocol: 'capability-notification-v1', provider: notification.provider, executionId,
              phase: 'after-agent', result, failures,
            }),
          }, { idempotencyKey });
        } catch {
          failures.push('audit-failed');
        }
        if (context.signal?.aborted && !failures.includes('cancelled')) {
          failures.push('cancelled');
          const cancellationKey = `${idempotencyKey}:cancellation`;
          try {
            await observation?.record({
              kind: 'effect.completed', effectKind: 'notification.cancellation', idempotencyKey: cancellationKey,
              outcome: 'failed', summary: JSON.stringify({
                protocol: 'capability-notification-v1', provider: notification.provider, executionId,
                phase: 'after-agent', result, failures,
              }),
            }, { idempotencyKey: cancellationKey });
          } catch {
            if (!failures.includes('audit-failed')) failures.push('audit-failed');
          }
        }
        if (failures.length) {
          const errors = failures.map(failure => new Error(failure === 'not-delivered' ? 'Capability notification was not delivered'
            : failure === 'provider-missing' ? 'Capability notification provider is not registered'
              : `Capability notification failed (${failure})`));
          if (errors.length === 1) throw errors[0];
          throw new AggregateError(errors, 'Capability notification failed to deliver or audit');
        }
      }
    },
  };
}

export interface VerificationSystemActionSelection {
  readonly name: string;
  readonly provider: string;
  readonly request: (input: unknown) => VerificationRequest | Promise<VerificationRequest>;
}

export function registerVerificationSystemActions(
  runtime: PluginRuntime,
  setup: Pick<PluginSetupContext, 'registerSystemAction'>,
  selection: readonly VerificationSystemActionSelection[],
): void {
  for (const action of selection) {
    setup.registerSystemAction(action.name, async (input, options) => {
      const result = verificationResultSchema.parse(await invokeCapability(runtime, {
        capability: 'verification.provider', provider: action.provider, operation: 'verify',
        input: await withCancellation(() => action.request(input), options),
      }, options));
      if (!result.passed) throw new Error('Capability verification failed');
      return result;
    });
  }
}
