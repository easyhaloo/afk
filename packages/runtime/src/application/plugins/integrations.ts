import type {
  ArtifactDescriptor, ArtifactRef, ContextFragment, ContextQuery, NotificationMessage,
  PolicyCheckInput, VerificationRequest,
} from '../../plugin-sdk/capabilities.js';
import type { LifecycleContext, LifecycleModule } from '../workflows/lifecycle.js';
import type { PluginRuntime, PluginSetupContext } from './runtime.js';
import {
  artifactRefSchema, contextFragmentsSchema, invokeCapability, notificationReceiptSchema, policyDecisionSchema, verificationResultSchema,
} from './operations.js';

type ContextValue<T> = (context: LifecycleContext) => T | Promise<T>;

export interface PublishedCapabilityArtifact {
  readonly provider: string;
  readonly artifact: ArtifactRef;
}

export interface CapabilityLifecycleSelection {
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
        capability: 'policy.provider', provider: policy.provider, operation: 'evaluate', input: await policy.input(context),
      }));
      if (!decision.allowed) throw new Error('Execution denied by capability policy');
    }
  };
  const verify = async (context: LifecycleContext) => {
    for (const verification of verifications) {
      const result = verificationResultSchema.parse(await invokeCapability(runtime, {
        capability: 'verification.provider', provider: verification.provider, operation: 'verify', input: await verification.request(context),
      }));
      if (!result.passed) throw new Error('Capability verification failed');
    }
  };
  return {
    name: 'capability-integrations',
    order: -100,
    failureMode: 'required',
    async onBeforePublish(context) {
      await evaluatePolicies(context);
      await verify(context);
    },
    async onBeforeAgent(context) {
      await evaluatePolicies(context);
      for (const source of contexts) {
        const fragments = contextFragmentsSchema.parse(await invokeCapability(runtime, {
          capability: 'context.provider', provider: source.provider, operation: 'gather', input: await source.query(context),
        }));
        await source.consume(fragments, context);
      }
    },
    async onAfterAgent(context) {
      await evaluatePolicies(context);
      await verify(context);
      const published: PublishedCapabilityArtifact[] = [];
      for (const sink of artifacts) {
        const descriptor = await sink.artifact(context);
        const artifact = artifactRefSchema.parse(await invokeCapability(runtime, {
          capability: 'artifact.provider', provider: sink.provider, operation: 'put',
          input: { ...descriptor, bytes: Buffer.from(descriptor.bytes).toString('base64') },
        }));
        await sink.publish(artifact, context);
        published.push({ provider: sink.provider, artifact });
      }
      for (const notification of notifications) {
        const receipt = notificationReceiptSchema.parse(await invokeCapability(runtime, {
          capability: 'notification.provider', provider: notification.provider, operation: 'notify',
          input: await notification.message(context, published),
        }));
        if (!receipt.delivered) throw new Error('Capability notification was not delivered');
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
    setup.registerSystemAction(action.name, async input => {
      const result = verificationResultSchema.parse(await invokeCapability(runtime, {
        capability: 'verification.provider', provider: action.provider, operation: 'verify', input: await action.request(input),
      }));
      if (!result.passed) throw new Error('Capability verification failed');
      return result;
    });
  }
}
