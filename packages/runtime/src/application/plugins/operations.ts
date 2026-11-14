import { z } from 'zod';
import type { PluginRuntime } from './runtime.js';
import type { PluginConfigValue } from '../../plugin-sdk/profile.js';
import type { ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';
import { withCancellation } from './cancellation.js';
import { RepositoryLifecycleService } from './repository-lifecycle.js';
import { experienceQueryContextSchema } from '../learning/experience-store.js';

const text = z.string().min(1).refine(value => value.trim().length > 0 && !value.includes('\0'));
const timeout = z.number().int().positive().max(2_147_483_647);
const scalar = z.union([z.string(), z.number().finite(), z.boolean()]);
const jsonValue: z.ZodType<PluginConfigValue> = z.lazy(() => z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(jsonValue), z.record(jsonValue)]));
const empty = z.object({}).strict();
const issueId = z.object({ issueId: text }).strict();
const commentId = issueId.extend({ commentId: text });
const relationType = z.enum(['blocks', 'blocked-by', 'relates-to', 'duplicates']);
const issueFields = { title: text, description: z.string().optional(), labels: z.array(text).optional() };
const numericId = z.number().int().positive().safe();
const trackerId = z.object({ id: numericId }).strict();
const trackerList = z.object({
  state: z.enum(['opened', 'closed', 'all']).optional(), perPage: z.number().int().positive().safe().optional(), projectId: text.optional(),
}).strict();
const trackerUpdates = z.object({ ...issueFields, title: text.optional(), state: z.enum(['open', 'closed']).optional() }).strict();
const repositoryRef = z.object({ url: text, ref: text.optional() }).strict();
const repositorySnapshot = z.object({ commit: text, branch: text, dirty: z.boolean() });
const repositoryPrepare = z.object({ repository: repositoryRef, runId: text }).strict();
const repositoryHandle = z.object({ workspaceId: text }).strict();
const repositoryWorkspace = z.object({ id: text, repository: repositoryRef, runId: text, snapshot: repositorySnapshot, path: text.optional() });
const repositoryPublication = z.object({ commit: text, branch: text, url: text.optional() });
const repositoryCleanup = z.object({ removed: z.boolean() });
const contextQuery = z.object({ scope: text, prompt: z.string(), limit: z.number().int().positive().optional(),
  applicability: z.unknown().optional(), target: z.unknown().optional(),
}).strict().transform(({ applicability, target, ...query }, context) => {
  const parsed = experienceQueryContextSchema.safeParse({ applicability, target });
  if (!parsed.success) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid context applicability' });
    return z.NEVER;
  }
  return { ...query, ...parsed.data };
});

export const verificationRequestSchema = z.object({
  target: text,
  command: z.array(z.string()).min(1).refine(argv => argv.length > 0 && argv[0].trim().length > 0 && argv.every(arg => !arg.includes('\0'))).optional(),
  timeoutMs: timeout.optional(),
}).strict();
export const verificationResultSchema = z.object({
  passed: z.boolean(), durationMs: z.number().finite().nonnegative(), output: z.string().optional(),
});
export const contextFragmentsSchema = z.array(z.object({
  content: z.string(), origin: z.string(), score: z.number().finite().optional(),
}));
export const policyDecisionSchema = z.object({
  allowed: z.boolean(), rule: z.string().optional(), reason: z.string().optional(),
});
export const artifactRefSchema = z.object({ uri: text, name: text });
export const notificationReceiptSchema = z.object({ delivered: z.boolean(), channel: z.string(), error: z.string().optional() });
const issue = z.object({
  id: text, key: text, projectId: text, title: z.string(), description: z.string(),
  state: z.string(), labels: z.array(z.string()), url: z.string().optional(),
});
const comment = z.object({
  id: text, issueId: text, body: z.string(), author: z.string().optional(),
  createdAt: z.string().optional(), updatedAt: z.string().optional(),
});
const relation = z.object({ id: text, sourceIssueId: text, targetIssueId: text, type: relationType });
const hostRecord = z.object({
  id: text, alias: text, provider: text, address: z.string().optional(), lastVerifiedAt: z.string().optional(),
});
const health = z.object({ status: z.enum(['ok', 'degraded', 'unavailable']), message: z.string().optional() });
const diagnostics = z.array(z.object({ check: z.string(), ok: z.boolean(), detail: z.string().optional() }));
const trackedIssue = z.object({
  id: numericId, platform: z.enum(['github', 'gitlab']), title: z.string(), description: z.string(),
  labels: z.array(z.string()), state: z.enum(['opened', 'closed', 'merged']), url: z.string(), projectId: z.string(),
});
const trackedMR = z.object({
  id: numericId, platform: z.enum(['github', 'gitlab']), title: z.string(), state: z.enum(['opened', 'merged', 'closed']),
  sourceBranch: z.string(), targetBranch: z.string(), url: z.string(), projectId: z.string(), description: z.string().optional(),
  mergeable: z.boolean().optional(), mergeState: z.enum(['mergeable', 'conflict', 'unknown']).optional(),
  pipeline: z.object({ status: z.string() }).optional(),
});

function operation<C extends string, O extends string, S extends z.ZodTypeAny>(capability: C, name: O, input: S) {
  return z.object({ capability: z.literal(capability), provider: text, operation: z.literal(name), input }).strict();
}

const invocationSchema = z.union([
  operation('verification.provider', 'verify', verificationRequestSchema),
  operation('notification.provider', 'notify', z.object({
    title: text, body: z.string(), channel: text.optional(), urgency: z.enum(['low', 'normal', 'high']).optional(),
  }).strict()),
  operation('context.provider', 'gather', contextQuery),
  operation('artifact.provider', 'put', z.object({
    name: text, mediaType: text,
    bytes: z.string().refine(value => Buffer.from(value, 'base64').toString('base64') === value),
  }).strict()),
  operation('repository.provider', 'snapshot', repositoryRef),
  operation('repository.provider', 'prepare', repositoryPrepare),
  operation('repository.provider', 'checkout', repositoryHandle),
  operation('repository.provider', 'publish', repositoryHandle),
  operation('repository.provider', 'cleanup', repositoryHandle),
  operation('repository.provider', 'run', repositoryPrepare.extend({ action: text, input: z.record(jsonValue) }).strict()),
  operation('policy.provider', 'evaluate', z.object({ action: text, context: z.record(scalar).optional() }).strict()),
  operation('trigger.provider', 'register', z.object({
    id: text, kind: z.enum(['schedule', 'webhook', 'manual']), schedule: text.optional(), payload: z.record(jsonValue).optional(), input: z.record(jsonValue).optional(),
  }).strict()),
  operation('trigger.provider', 'unregister', z.object({ triggerId: text }).strict()),
  operation('tracker.issue', 'getIssue', issueId),
  operation('tracker.issue', 'listIssues', z.object({
    state: text.optional(), labels: z.array(text).optional(), limit: z.number().int().positive().optional(), cursor: text.optional(),
  }).strict()),
  operation('tracker.issue', 'createIssue', z.object({ ...issueFields, issueType: text.optional() }).strict()),
  operation('tracker.issue', 'updateIssue', issueId.extend({
    input: z.object({ ...issueFields, title: text.optional(), state: text.optional() }).strict(),
  })),
  operation('tracker.issue', 'deleteIssue', issueId),
  operation('tracker.issue', 'addComment', issueId.extend({ body: text })),
  operation('tracker.issue', 'listComments', issueId),
  operation('tracker.issue', 'updateComment', commentId.extend({ body: text })),
  operation('tracker.issue', 'deleteComment', commentId),
  operation('tracker.issue', 'linkIssues', z.object({ sourceIssueId: text, targetIssueId: text, type: relationType }).strict()),
  operation('tracker.issue', 'listIssueLinks', issueId),
  operation('tracker.issue', 'health', empty),
  operation('tracker.issue', 'doctor', empty),
  operation('tracker.provider', 'getIssue', trackerId),
  operation('tracker.provider', 'listIssues', trackerList.extend({ labels: z.array(text).optional() })),
  operation('tracker.provider', 'createIssue', z.object(issueFields).strict()),
  operation('tracker.provider', 'updateIssue', trackerId.extend({ updates: trackerUpdates })),
  operation('tracker.provider', 'updateLabels', trackerId.extend({ delta: z.object({ add: z.array(text), remove: z.array(text) }).strict() })),
  operation('tracker.provider', 'addLabel', trackerId.extend({ label: text })),
  operation('tracker.provider', 'removeLabel', trackerId.extend({ label: text })),
  operation('tracker.provider', 'addComment', trackerId.extend({ body: text })),
  operation('tracker.provider', 'listIssueComments', trackerId),
  operation('tracker.provider', 'updateIssueComment', trackerId.extend({ commentId: text, body: text })),
  operation('tracker.provider', 'linkIssues', z.object({
    sourceId: numericId, targetId: numericId, type: z.enum(['blocks', 'is_blocked_by', 'blocked_by', 'related_to']), targetProjectId: text.optional(),
  }).strict()),
  operation('tracker.provider', 'getMR', trackerId),
  operation('tracker.provider', 'listMRs', trackerList),
  operation('tracker.provider', 'createMR', z.object({
    ...issueFields, sourceBranch: text, targetBranch: text, draft: z.boolean().optional(),
  }).strict()),
  operation('tracker.provider', 'updateMR', trackerId.extend({ updates: z.object({ description: z.string().optional() }).strict() })),
  operation('tracker.provider', 'closeMR', trackerId.extend({ comment: z.string().optional() })),
  operation('tracker.provider', 'reopenMR', trackerId),
  operation('tracker.provider', 'isMRLinkedToIssue', trackerId.extend({ canonicalWorkItemId: text })),
  operation('host.connection', 'listHosts', empty),
  operation('host.connection', 'resolve', z.object({ host: text }).strict()),
  operation('host.connection', 'exec', z.object({
    host: text, argv: z.array(z.string().refine(value => !value.includes('\0'))).min(1).refine(argv => argv.length > 0 && argv[0].trim().length > 0),
    timeoutMs: timeout.optional(),
  }).strict()),
  operation('host.connection', 'upload', z.object({
    host: text, source: text, destination: text, timeoutMs: timeout.optional(),
  }).strict()),
]);

export type CapabilityInvocation = z.input<typeof invocationSchema>;

function required<T>(provider: T | undefined): T {
  if (!provider) throw new Error('Capability provider is not registered');
  return provider;
}

function output<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid capability result');
  return parsed.data;
}

export async function invokeCapability(runtime: PluginRuntime, input: unknown, options?: ProviderOperationOptions): Promise<unknown> {
  const fields = input && typeof input === 'object' ? Object.getOwnPropertyDescriptors(input) : undefined;
  const ownEnvelope = fields && ['capability', 'provider', 'operation', 'input']
    .every(key => Object.hasOwn(fields, key) && Object.hasOwn(fields[key], 'value'));
  const query = ownEnvelope && fields.capability.value === 'context.provider' ? fields.input.value : undefined;
  const unsafeContext = query && typeof query === 'object' && ['scope', 'prompt', 'limit', 'applicability', 'target']
    .some(key => key in query && !Object.hasOwn(Object.getOwnPropertyDescriptor(query, key) ?? {}, 'value'));
  const parsed = invocationSchema.safeParse(ownEnvelope && !unsafeContext ? input : undefined);
  if (!parsed.success) throw new Error('Invalid or unsupported capability invocation; credential operations are private');
  const request = parsed.data;
  if (request.capability === 'repository.provider') {
    await withCancellation(() => undefined, options);
    return dispatchCapability(runtime, request, options);
  }
  return withCancellation(() => dispatchCapability(runtime, request, options), options);
}

async function dispatchCapability(runtime: PluginRuntime, request: z.output<typeof invocationSchema>, options?: ProviderOperationOptions): Promise<unknown> {
  const forwarded: [] | [ProviderOperationOptions] = options ? [options] : [];
  switch (request.capability) {
    case 'verification.provider':
      return output(verificationResultSchema, await required(runtime.getVerificationProvider(request.provider)).verify(request.input, ...forwarded));
    case 'notification.provider':
      return output(notificationReceiptSchema, await required(runtime.getNotificationProvider(request.provider)).notify(request.input, ...forwarded));
    case 'context.provider':
      return output(contextFragmentsSchema, await required(runtime.getContextProvider(request.provider)).gather(request.input, ...forwarded));
    case 'artifact.provider':
      return output(artifactRefSchema, await required(runtime.getArtifactProvider(request.provider)).put({
        ...request.input, bytes: Buffer.from(request.input.bytes, 'base64'),
      }, ...forwarded));
    case 'repository.provider': {
      const provider = required(runtime.getRepositoryProvider(request.provider));
      if (request.operation === 'snapshot') return output(repositorySnapshot, await provider.snapshot(request.input, ...forwarded));
      if (request.operation === 'run') {
        if (!runtime.listSystemActions().includes(request.input.action)) throw new Error('Repository execution action is not registered');
        const result = await new RepositoryLifecycleService(provider).run({ repository: request.input.repository, runId: request.input.runId }, workspace => runtime.dispatchSystemAction(request.input.action, {
          input: request.input.input, repositoryWorkspace: workspace, worktreePath: workspace.path,
        }, options), options);
        return output(z.object({ value: z.unknown(), workspace: repositoryWorkspace, publication: repositoryPublication, cleanup: repositoryCleanup }), result);
      }
      const operation = request.operation;
      if (!provider.capabilities[operation] || !provider[operation]) throw new Error(`Repository provider does not support ${operation}`);
      if (operation === 'prepare') return output(repositoryWorkspace, await provider.prepare!(request.input, ...forwarded));
      if (operation === 'checkout') return output(repositoryWorkspace, await provider.checkout!(request.input, ...forwarded));
      if (operation === 'publish') return output(repositoryPublication, await provider.publish!(request.input, ...forwarded));
      return output(repositoryCleanup, await provider.cleanup!(request.input, ...forwarded));
    }
    case 'policy.provider':
      return output(policyDecisionSchema, await required(runtime.getPolicyProvider(request.provider)).evaluate(request.input, ...forwarded));
    case 'trigger.provider': {
      const provider = required(runtime.getTriggerProvider(request.provider));
      if (request.operation === 'register') return output(z.void(), await provider.register(request.input));
      return output(z.void(), await provider.unregister(request.input.triggerId, ...forwarded));
    }
    case 'tracker.issue': {
      const provider = required(runtime.getIssueTrackerProvider(request.provider));
      switch (request.operation) {
        case 'getIssue': return output(issue, await provider.getIssue(request.input.issueId));
        case 'listIssues': return output(z.array(issue), await provider.listIssues(request.input));
        case 'createIssue': return output(issue, await provider.createIssue(request.input));
        case 'updateIssue': return output(issue, await provider.updateIssue(request.input.issueId, request.input.input));
        case 'deleteIssue': return output(z.void(), await provider.deleteIssue(request.input.issueId));
        case 'addComment': return output(comment, await provider.addComment(request.input.issueId, request.input.body));
        case 'listComments': return output(z.array(comment), await provider.listComments(request.input.issueId));
        case 'updateComment': return output(comment, await provider.updateComment(request.input.issueId, request.input.commentId, request.input.body));
        case 'deleteComment': return output(z.void(), await provider.deleteComment(request.input.issueId, request.input.commentId));
        case 'linkIssues': return output(relation, await provider.linkIssues(request.input.sourceIssueId, request.input.targetIssueId, request.input.type));
        case 'listIssueLinks': return output(z.array(relation), await provider.listIssueLinks(request.input.issueId));
        case 'health': return output(health, await provider.health());
        case 'doctor': return output(diagnostics, await provider.doctor());
      }
    }
    case 'tracker.provider': {
      const provider = required(runtime.getTrackerProvider(request.provider));
      switch (request.operation) {
        case 'getIssue': return output(trackedIssue, await provider.getIssue(request.input.id));
        case 'listIssues': return output(z.array(trackedIssue), await provider.listIssues(request.input));
        case 'createIssue': return output(numericId, await provider.createIssue(request.input));
        case 'updateIssue': return output(z.void(), await provider.updateIssue(request.input.id, request.input.updates));
        case 'updateLabels': return output(z.void(), await provider.updateLabels(request.input.id, request.input.delta));
        case 'addLabel': return output(z.void(), await provider.addLabel(request.input.id, request.input.label));
        case 'removeLabel': return output(z.void(), await provider.removeLabel(request.input.id, request.input.label));
        case 'addComment': return output(z.void(), await provider.addComment(request.input.id, request.input.body));
        case 'listIssueComments': return output(z.array(z.object({ id: text, body: z.string() })), await provider.listIssueComments(request.input.id));
        case 'updateIssueComment': return output(z.void(), await provider.updateIssueComment(request.input.id, request.input.commentId, request.input.body));
        case 'linkIssues': return output(z.void(), await provider.linkIssues(request.input.sourceId, request.input.targetId, request.input.type, request.input.targetProjectId));
        case 'getMR': return output(trackedMR, await provider.getMR(request.input.id));
        case 'listMRs': return output(z.array(trackedMR), await provider.listMRs(request.input));
        case 'createMR': return output(numericId, await provider.createMR(request.input));
        case 'updateMR':
          if (!provider.updateMR) throw new Error('Tracker provider does not support updateMR');
          return output(z.void(), await provider.updateMR(request.input.id, request.input.updates));
        case 'closeMR': return output(z.void(), await provider.closeMR(request.input.id, { comment: request.input.comment }));
        case 'reopenMR': return output(z.void(), await provider.reopenMR(request.input.id));
        case 'isMRLinkedToIssue': return output(z.boolean(), await provider.isMRLinkedToIssue(request.input.id, request.input.canonicalWorkItemId));
      }
    }
    case 'host.connection': {
      const provider = required(runtime.getHostProvider(request.provider));
      switch (request.operation) {
        case 'listHosts': return output(z.array(hostRecord), await provider.listHosts());
        case 'resolve': return output(hostRecord, await provider.resolve(request.input.host));
        case 'exec': return output(z.object({ code: z.number().int(), stdout: z.string(), stderr: z.string() }),
          await provider.exec(request.input.host, request.input.argv, { timeoutMs: request.input.timeoutMs, ...options }));
        case 'upload':
          if (!provider.upload) throw new Error('Host provider does not support upload');
          return output(z.void(), await provider.upload(request.input.host, request.input.source, request.input.destination, { timeoutMs: request.input.timeoutMs, ...options }));
      }
    }
  }
}
