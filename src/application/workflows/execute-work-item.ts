import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { lstat, mkdir, open, readFile, rename, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadWorkItemExecution, type WorkItemExecution } from '@afk/application';
import { WorkflowRunner } from '../workflow-engine';
import { QARunner } from '../modules/qa-runner';
import { createGlobalWorkItemCatalogs, createTracker } from '../tracker-provider-factory';
import { collectGlobalWorkItemInventory } from '../work-items/inventory';
import { createProviderBundle, type ProviderBundle, type ManagementProviderBundle } from '../providers';
import { ManagementBacklogProvider } from '../../domain/backlog/management-provider';
import { parseWorkItemId, encodeWorkItemIdForPath, type BacklogItem } from '../../domain/backlog';
import type { GlobalWorkItem } from '../../domain/work-item/types';
import { prepareAgentRuntime } from '../../domain/agents/index';
import { getWorkflowConfig, type WorkflowConfig } from '../../infrastructure/config/manager';
import type { ObservationContext, RunEventData } from '@afk/core';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store';
import { createRunObserver } from '../../infrastructure/observability/run-observer-factory';
import { RunObserver } from '../../observability/run-observer';
import { projectWorkItemExecution } from '../../observability/work-item-execution-projection';
import { readExecutionManifest, type ResolvedExecutionManifest } from './execution-manifest';
import { resolveWorkflowRunRequest, type WorkflowRunRequest } from './run-request';

export interface ExecuteWorkItemInput {
  workItemId: string;
  executionId?: string;
  manifestPath: string;
  template?: string;
  project?: string;
}

export type ExecuteWorkItemStatus = 'merge_ready' | 'done' | 'rework' | 'blocked' | 'not_claimed';
export interface ExecuteWorkItemResult {
  executionId: string;
  workItemId: string;
  status: ExecuteWorkItemStatus;
  changeUrl?: string;
}

type Implementation = Pick<WorkflowRunner, 'run'>;
type Verification = Pick<QARunner, 'process'>;
type ProcessStatus = 'alive' | 'dead' | 'unknown';

interface LockIdentity {
  pid: number;
  host: string;
  processStart: string;
}

interface LockProbe {
  identity(): Promise<LockIdentity | undefined>;
  status(pid: number): Promise<ProcessStatus>;
  start?(pid: number): Promise<string | undefined>;
}

interface LockOwner extends LockIdentity {
  version: 1;
  workItemId: string;
  executionId: string;
  nonce: string;
}

const execFileAsync = promisify(execFile);
const executionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const defaultLockProbe: LockProbe = {
  async start(pid) {
    try {
      const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)]);
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  },
  async identity() {
    const processStart = await this.start!(process.pid);
    return processStart ? { pid: process.pid, host: hostname(), processStart } : undefined;
  },
  async status(pid) {
    try {
      process.kill(pid, 0);
      return 'alive';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'dead';
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return 'alive';
      return 'unknown';
    }
  },
};

function validIdentity(value: unknown): value is LockIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Partial<LockIdentity>;
  return Number.isSafeInteger(identity.pid) && identity.pid! > 0
    && typeof identity.host === 'string' && identity.host.length > 0 && identity.host.length <= 255
    && typeof identity.processStart === 'string' && identity.processStart.trim() === identity.processStart
    && identity.processStart.length > 0 && identity.processStart.length <= 128;
}

function parseLockOwner(raw: string, workItemId: string, host: string): LockOwner {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`cannot verify lock owner identity for ${workItemId}`);
  }
  if (!validIdentity(value)) throw new Error(`cannot verify lock owner identity for ${workItemId}`);
  const owner = value as LockOwner;
  if (Object.keys(owner).sort().join(',') !== 'executionId,host,nonce,pid,processStart,version,workItemId'
    || owner.version !== 1 || owner.host !== host || owner.workItemId !== workItemId
    || !executionIdPattern.test(owner.executionId) || !uuidPattern.test(owner.nonce)) {
    throw new Error(`cannot verify lock owner identity for ${workItemId}`);
  }
  return owner;
}

async function releaseLock(lock: FileHandle, lockPath: string): Promise<void> {
  try {
    const [owned, current] = await Promise.all([lock.stat(), lstat(lockPath)]);
    if (owned.dev === current.dev && owned.ino === current.ino) await unlink(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  } finally {
    await lock.close();
  }
}

async function recoverDeadLock(lockPath: string, workItemId: string, identity: LockIdentity, probe: LockProbe): Promise<void> {
  const guardPath = `${lockPath}.recovery`;
  let guard: FileHandle;
  try {
    guard = await open(guardPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`active attempt recovery already exists for ${workItemId}`);
    throw error;
  }
  try {
    const before = await lstat(lockPath);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 1024) {
      throw new Error(`cannot verify lock owner identity for ${workItemId}`);
    }
    const owner = parseLockOwner(await readFile(lockPath, 'utf8'), workItemId, identity.host);
    const status = await probe.status(owner.pid);
    if (status === 'alive') {
      const currentStart = await probe.start?.(owner.pid);
      if (!currentStart || currentStart === owner.processStart) throw new Error(`active attempt already exists for ${workItemId}`);
    } else if (status !== 'dead') throw new Error(`cannot verify lock owner identity for ${workItemId}`);
    const after = await lstat(lockPath);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      throw new Error(`cannot verify lock owner identity for ${workItemId}`);
    }
    await rename(lockPath, `${lockPath}.stale-${randomUUID()}`);
  } finally {
    await guard.close();
    await unlink(guardPath);
  }
}

async function acquireLock(lockPath: string, workItemId: string, executionId: string, probe: LockProbe): Promise<FileHandle> {
  const identity = await probe.identity();
  if (!validIdentity(identity)) throw new Error(`cannot verify current process identity for ${workItemId}`);
  let lock: FileHandle;
  try {
    lock = await open(lockPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    await recoverDeadLock(lockPath, workItemId, identity, probe);
    try {
      lock = await open(lockPath, 'wx');
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`active attempt already exists for ${workItemId}`);
      throw retryError;
    }
  }
  try {
    const owner: LockOwner = { version: 1, ...identity, workItemId, executionId, nonce: randomUUID() };
    await lock.writeFile(JSON.stringify(owner));
    await lock.sync();
    return lock;
  } catch (error) {
    await releaseLock(lock, lockPath);
    throw error;
  }
}

export interface ExecuteWorkItemDependencies {
  readManifest?: typeof readExecutionManifest;
  lookupWorkItem?: (id: string) => Promise<GlobalWorkItem>;
  createContext?: (manifest: ResolvedExecutionManifest, input: ExecuteWorkItemInput, config: WorkflowConfig) => Promise<{
    request: WorkflowRunRequest;
    providers: ProviderBundle;
  }>;
  createImplementation?: (providers: ProviderBundle, config: WorkflowConfig, request: WorkflowRunRequest) => Implementation;
  createQA?: (providers: ManagementProviderBundle, config: WorkflowConfig, request: WorkflowRunRequest) => Verification;
  recordAudit?: (context: ObservationContext, data: RunEventData) => Promise<unknown>;
  loadExecution?: (runId: string) => Promise<WorkItemExecution>;
  lockProbe?: LockProbe;
}

async function lookupWorkItem(id: string): Promise<GlobalWorkItem> {
  const inventory = await collectGlobalWorkItemInventory(createGlobalWorkItemCatalogs(parseWorkItemId(id).platform));
  const item = inventory.items.find(candidate => candidate.id === id);
  if (!item) throw new Error(`work item ${id} is absent from global inventory${inventory.diagnostics.length ? ` (${inventory.diagnostics.map(diagnostic => diagnostic.message).join('; ')})` : ''}`);
  return item;
}

async function createContext(manifest: ResolvedExecutionManifest, input: ExecuteWorkItemInput, config: WorkflowConfig) {
  const request = await resolveWorkflowRunRequest({
    backlogId: input.workItemId,
    executionManifestPath: manifest.manifestPath,
    template: input.template,
    projectName: input.project,
    executionMode: 'batch',
  }, config);
  const tracker = await createTracker(request.trackerProjectId ?? request.projectName, request.repoRoot, request.trackerPlatform, request.trackerHost);
  return { request, providers: createProviderBundle(tracker, request.repoRoot) };
}

function validateItem(item: BacklogItem, inventoryItem: GlobalWorkItem, manifest: ResolvedExecutionManifest, workItemId: string): void {
  const identity = parseWorkItemId(workItemId);
  if (inventoryItem.id !== workItemId || item.id !== manifest.providerBacklogId
    || Number(item.id) !== identity.issueNumber || inventoryItem.issueNumber !== identity.issueNumber
    || inventoryItem.project.platform !== identity.platform || inventoryItem.project.projectKey !== identity.projectKey
    || (item.workItemId !== undefined && item.workItemId !== workItemId)
    || (item.issueNumber !== undefined && item.issueNumber !== identity.issueNumber)
    || (item.project !== undefined && (item.project.platform !== identity.platform || item.project.projectKey !== identity.projectKey))
    || (item.providerRef !== workItemId && item.providerRef !== `${identity.platform}:${manifest.tracker.providerProjectId ?? identity.projectKey}#${identity.issueNumber}`)
    || manifest.tracker.platform !== identity.platform
    || manifest.tracker.projectKey !== identity.projectKey) {
    throw new Error(`work item identity does not match provider and execution manifest: ${workItemId}`);
  }
  if (!inventoryItem.managed || item.managed === false) throw new Error(`unmanaged work item: ${workItemId}`);
  if (!inventoryItem.executionEligible || item.executionEligible === false) throw new Error(`ineligible work item: ${workItemId}`);
  if (item.executionMode !== 'afk' || inventoryItem.executionMode !== 'afk') throw new Error(`work item ${workItemId} is hitl`);
  if ((item.state !== 'ready' && item.state !== 'rework') || item.state !== inventoryItem.state) throw new Error(`work item ${workItemId} must be ready or rework`);
}

export async function executeWorkItem(input: ExecuteWorkItemInput, dependencies: ExecuteWorkItemDependencies = {}): Promise<ExecuteWorkItemResult> {
  const workItemId = parseWorkItemId(input.workItemId).id;
  const executionId = input.executionId ?? randomUUID();
  if (!executionIdPattern.test(executionId)) throw new Error('invalid executionId');
  const context: ObservationContext = {
    traceId: executionId, runId: executionId, workItemId, profileId: process.env.AFK_PROFILE ?? 'default',
    attempt: 1, actor: { kind: 'system', id: 'execute' },
  };
  const observer = dependencies.recordAudit ? undefined : new RunObserver({ events: new JsonlEventStore({ root: process.env.AFK_EVENT_STORE_DIR }) });
  const recordAudit = dependencies.recordAudit ?? ((auditContext: ObservationContext, data: RunEventData) => observer!.record(auditContext, data));
  const audit = async (data: RunEventData) => { await recordAudit(context, data); };
  const manifest = await (dependencies.readManifest ?? readExecutionManifest)(input.manifestPath, workItemId);
  const directory = join(manifest.workspaceRoot, '.afk', 'executions');
  await mkdir(directory, { recursive: true });
  const lockPath = join(directory, `${encodeWorkItemIdForPath(workItemId)}.lock`);
  const lock = await acquireLock(lockPath, workItemId, executionId, dependencies.lockProbe ?? defaultLockProbe);
  try {
    const journal = await open(join(directory, `${executionId}.jsonl`), 'wx');
    try {
      const record = async (phase: string, details: object = {}) => {
        await journal.writeFile(`${JSON.stringify({ executionId, workItemId, phase, at: new Date().toISOString(), ...details })}\n`);
        await journal.sync();
      };
      await record('requested');
      let implementationCompleted = false;
      let auditConcluded = false;
      try {
        const config = getWorkflowConfig();
        const { request, providers } = await (dependencies.createContext ?? createContext)(manifest, input, config);
        if (request.backlogId !== manifest.providerBacklogId) throw new Error('resolved request backlog identity mismatch');
        const item = await providers.backlog.get(request.backlogId);
        const inventoryItem = await (dependencies.lookupWorkItem ?? lookupWorkItem)(workItemId);
        validateItem(item, inventoryItem, manifest, workItemId);
        for (const dependencyId of item.dependsOn) {
          const dependency = await providers.backlog.get(dependencyId);
          if (dependency.state !== 'done') throw new Error(`unmet dependency ${dependencyId}`);
        }
        if (!(await providers.backlog.isRunnable(item))) throw new Error(`work item ${workItemId} has unmet dependencies or is not runnable`);
        const existing = await providers.changes.findForBacklog(item);
        if (existing?.state === 'open') throw new Error(`work item already has an open change request: ${existing.url ?? existing.id}`);
        request.agentRuntime = await prepareAgentRuntime(request.agentRuntime);
        await record('implementing');
        const implementation = (dependencies.createImplementation ?? ((bundle, workflowConfig, runRequest) =>
          new WorkflowRunner(bundle, { config: workflowConfig, agentRuntime: runRequest.agentRuntime, observer: createRunObserver() })))(providers, config, request);
        const implementationResult = await implementation.run({ ...request, template: input.template ?? request.template, session: executionId,
          executionMode: 'batch', observationRunId: executionId, observationWorkItemId: workItemId, auditRequired: true });
        if (!implementationResult.success) {
          const status = implementationResult.skipped === 'not_claimed' ? 'not_claimed' : 'blocked';
          await record(status);
          return { executionId, workItemId, status };
        }
        implementationCompleted = true;
        const verificationItem = await providers.backlog.get(request.backlogId);
        if (verificationItem.state !== 'verification') throw new Error('implementation did not enter verification');
        await record('verifying');
        await audit({ kind: 'qa.started' });
        let qaPassedRecorded = false;
        const auditQAPass = async () => {
          if (qaPassedRecorded) return;
          await audit({ kind: 'qa.passed' });
          qaPassedRecorded = true;
        };
        const management: ManagementProviderBundle = {
          backlog: new ManagementBacklogProvider(providers.backlog), branches: providers.branches, changes: providers.changes,
        };
        const qa = (dependencies.createQA ?? ((bundle, workflowConfig, runRequest) =>
          new QARunner(bundle, workflowConfig, {
            agentRuntime: runRequest.agentRuntime, executionMode: 'batch', projectRoot: runRequest.workspaceRoot,
            beforeChange: async (action, _backlog, change) => {
              if (action === 'publish') await auditQAPass();
              if (action === 'merge' && change) await providers.changes.verifyIssueAssociation(change, workItemId);
              await record(action === 'publish' ? 'publication_requested' : 'merge_requested', change ? { changeId: change.id, changeUrl: change.url } : {});
            },
            afterPublication: async change => {
              await providers.changes.verifyIssueAssociation(change, workItemId);
              await record('published', { changeId: change.id, changeUrl: change.url });
            },
          })))(management, config, request);
        const qaResult = await qa.process(request.backlogId);
        if (qaResult.success) await auditQAPass();
        else await audit({ kind: 'qa.failed', reason: qaResult.rework ? 'rework' : 'blocked' });
        const change = qaResult.success ? await providers.changes.findForBacklog(item) : null;
        const finalItem = qaResult.success ? await providers.backlog.get(request.backlogId) : null;
        const published = change && change.id && change.url && change.url === qaResult.mrUrl
          && (change.state === 'open' || change.state === 'merged');
        if (published) await providers.changes.verifyIssueAssociation(change, workItemId);
        const rootPublished = !item.parentId && qaResult.autoMerged === false && change?.state === 'open' && finalItem?.state === 'merge_ready';
        const childMerged = !!item.parentId && qaResult.autoMerged === true && change?.state === 'merged' && finalItem?.state === 'done';
        const status: ExecuteWorkItemStatus = qaResult.success && published && (rootPublished || childMerged)
          ? childMerged ? 'done' : 'merge_ready'
          : qaResult.rework ? 'rework' : 'blocked';
        if (status === 'merge_ready' || status === 'done') {
          await audit({ kind: 'change.published', changeId: String(change!.id), url: change!.url! });
          if (status === 'done') {
            await audit({ kind: 'change.merge_verified', changeId: String(change!.id), targetBranch: request.targetBranch, child: true });
            await audit({ kind: 'run.finished', outcome: 'succeeded' });
          } else await audit({ kind: 'human_gate.opened', gateId: `merge:${change!.id}`, reason: 'awaiting human merge' });
        } else await audit({ kind: 'run.finished', outcome: 'failed', reason: status === 'rework' ? 'QA requested rework' : 'QA or provider change not confirmed' });
        auditConcluded = true;
        await record(status, published ? { changeId: change.id, changeUrl: change.url } : {});
        return { executionId, workItemId, status, ...(published ? { changeUrl: change.url } : {}) };
      } catch (error) {
        if (implementationCompleted && !auditConcluded) {
          await audit({ kind: 'run.finished', outcome: 'failed', reason: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
        }
        await record('failed', { reason: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    } finally {
      await journal.close();
    }
  } finally {
    await releaseLock(lock, lockPath);
  }
}

async function journalPublication(manifest: ResolvedExecutionManifest, executionId: string, workItemId: string): Promise<{ requested: boolean; published?: { id: string; url: string } }> {
  let contents: string;
  try {
    contents = await readFile(join(manifest.workspaceRoot, '.afk', 'executions', `${executionId}.jsonl`), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { requested: false };
    throw error;
  }
  let publication: { id: string; url: string } | undefined;
  let requested = false;
  for (const line of contents.split('\n').filter(Boolean)) {
    const entry = JSON.parse(line) as { executionId: string; workItemId: string; phase: string; at: string; [key: string]: unknown };
    if (entry.phase === 'publication_requested') {
      if (entry.executionId !== executionId || entry.workItemId !== workItemId) throw new Error('publication journal identity mismatch');
      requested = true;
    }
    if (entry.phase !== 'published') continue;
    if (entry.executionId !== executionId || entry.workItemId !== workItemId
      || typeof entry.changeId !== 'string' || !entry.changeId
      || typeof entry.changeUrl !== 'string' || !entry.changeUrl.startsWith('https://')) {
      throw new Error('publication journal identity mismatch');
    }
    if (publication && (publication.id !== entry.changeId || publication.url !== entry.changeUrl)) {
      throw new Error('conflicting publication journal records');
    }
    publication = { id: entry.changeId, url: entry.changeUrl };
  }
  return { requested, ...(publication ? { published: publication } : {}) };
}

export async function reconcileWorkItemMerge(input: ExecuteWorkItemInput, dependencies: ExecuteWorkItemDependencies = {}): Promise<ExecuteWorkItemResult> {
  const workItemId = parseWorkItemId(input.workItemId).id;
  const executionId = input.executionId;
  if (!executionId || !executionIdPattern.test(executionId)) throw new Error('valid executionId is required');
  const manifest = await (dependencies.readManifest ?? readExecutionManifest)(input.manifestPath, workItemId);
  const lockPath = join(manifest.workspaceRoot, '.afk', 'executions', `${encodeWorkItemIdForPath(workItemId)}.lock`);
  await mkdir(join(manifest.workspaceRoot, '.afk', 'executions'), { recursive: true });
  const lock = await acquireLock(lockPath, workItemId, executionId, dependencies.lockProbe ?? defaultLockProbe);
  try {
    const store = new JsonlEventStore({ root: process.env.AFK_EVENT_STORE_DIR });
    const execution = await (dependencies.loadExecution ?? (runId => loadWorkItemExecution(runId, {
      events: store, projection: { project: projectWorkItemExecution },
    })))(executionId);
    const { summary, timeline } = execution;
    if (!timeline.integrity.valid || summary.workItemId !== workItemId || summary.executionId !== executionId) {
      throw new Error('execution audit identity or integrity mismatch');
    }
    if (summary.status === 'done' && summary.pr?.state === 'merged'
      && timeline.events.some(event => event.data.kind === 'change.merge_verified'
        && event.data.changeId === summary.pr?.id && event.data.child === false)) {
      return { executionId, workItemId, status: 'done', changeUrl: summary.pr.url };
    }
    const journal = summary.status === 'publishing'
      ? await journalPublication(manifest, executionId, workItemId) : undefined;
    if ((summary.status !== 'publishing' && summary.status !== 'awaiting_merge')
      || !timeline.events.some(event => event.data.kind === 'qa.passed')
      || (summary.status === 'publishing' && !journal?.requested && !journal?.published)
      || (summary.status === 'awaiting_merge' && (!summary.pr?.id || !summary.pr.url
        || !timeline.events.some(event => event.data.kind === 'change.published'
          && event.data.changeId === summary.pr?.id && event.data.url === summary.pr.url)))) {
      throw new Error('execution is not awaiting a verified root PR merge');
    }
    const { request, providers } = await (dependencies.createContext ?? createContext)(manifest, input, getWorkflowConfig());
    if (request.backlogId !== manifest.providerBacklogId) throw new Error('resolved request backlog identity mismatch');
    const item = await providers.backlog.get(request.backlogId);
    const identity = parseWorkItemId(workItemId);
    if (item.parentId || item.id !== manifest.providerBacklogId
      || (item.workItemId !== undefined && item.workItemId !== workItemId)
      || (item.providerRef !== workItemId
        && item.providerRef !== `${identity.platform}:${manifest.tracker.providerProjectId ?? identity.projectKey}#${identity.issueNumber}`)
      || (item.state !== 'verification' && item.state !== 'merge_ready' && item.state !== 'done')
      || (item.state === 'verification' && summary.status !== 'publishing')) {
      throw new Error('root backlog identity or merge state mismatch');
    }
    const publication = summary.status === 'awaiting_merge' ? summary.pr : journal?.published;
    const change = publication ? await providers.changes.get(publication.id) : await providers.changes.findForBacklog(item);
    if (!change?.id || !change.url
      || (publication && (change.id !== publication.id || change.url !== publication.url))
      || (item.changeRequest && item.changeRequest.id !== change.id)
      || (change.sourceBranch !== item.branchName && change.sourceBranch !== `${item.branchName}-qa`)
      || change.targetBranch !== request.targetBranch) {
      throw new Error('provider change request identity mismatch');
    }
    if (change.state !== 'open' && change.state !== 'merged') throw new Error('provider change request is closed without merge');
    if (item.state === 'done' && change.state !== 'merged') throw new Error('backlog is done without a merged provider change request');
    await providers.changes.verifyIssueAssociation(change, workItemId);
    const recordAudit = dependencies.recordAudit ?? ((context: ObservationContext, data: RunEventData) => new RunObserver({ events: store }).record(context, data));
    const context: ObservationContext = {
      traceId: executionId, runId: executionId, workItemId, profileId: process.env.AFK_PROFILE ?? 'default',
      attempt: 1, actor: { kind: 'system', id: 'merge-reconciliation' },
    };
    if (item.state === 'verification' && change.state === 'open') await providers.backlog.transition(item.id, 'merge_ready', { changeId: change.id });
    if (change.state === 'open' && item.executionMode !== 'hitl') await providers.backlog.setExecutionMode(item.id, 'hitl');
    if (summary.status === 'publishing') await recordAudit(context, { kind: 'change.published', changeId: change.id, url: change.url });
    if (change.state !== 'merged') return { executionId, workItemId, status: 'merge_ready', changeUrl: change.url };
    if (item.state !== 'done') await providers.backlog.transition(item.id, 'done', { changeId: change.id });
    await recordAudit(context, { kind: 'change.merge_verified', changeId: change.id, targetBranch: change.targetBranch, child: false });
    return { executionId, workItemId, status: 'done', changeUrl: change.url };
  } finally {
    await releaseLock(lock, lockPath);
  }
}
