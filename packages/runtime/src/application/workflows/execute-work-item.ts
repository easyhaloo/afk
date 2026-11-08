import { workspaceDataDirectory } from '../../infrastructure/workspace.js';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, rename, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadWorkItemExecution, type WorkItemExecution } from '@afk/application';
import { WorkflowRunner } from '../workflow-engine.js';
import { QARunner } from '../runners/qa-runner.js';
import { createGlobalWorkItemCatalogs } from '../../infrastructure/provider/tracker-provider-factory.js';
import { collectGlobalWorkItemInventory } from '../../infrastructure/provider/inventory.js';
import { asManagementProviders, type ProviderBundle, type ManagementProviderBundle } from '../../infrastructure/provider/providers.js';
import { assembleProviders } from '../../infrastructure/provider/assembly.js';
import { parseWorkItemId, encodeWorkItemIdForPath, type BacklogItem } from '../../domain/backlog/index.js';
import { createExecutionPlan, parseExecutionPlan } from '../../domain/backlog/execution-plan.js';
import { resolveParentPrdBaseline, resolvePrdExecutionPlan } from '../../domain/backlog/prd-baseline.js';
import { BACKLOG_METADATA } from '../../domain/backlog/initialization.js';
import type { GlobalWorkItem } from '../../domain/work-item/types.js';
import { AgentProviderRegistry, defaultAgentProviderRegistry, ensureBuiltinAgentProviders, prepareAgentRuntime } from '../../domain/agents/index.js';
import { getWorkflowConfig, repositoryExecutionDefaults, type WorkflowConfig } from '../../infrastructure/config/manager.js';
import type { ObservationContext, RunEventData } from '@afk/core';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import { createPluginRunObserver } from '../plugins/observability.js';
import { projectWorkItemExecution } from '../../observability/work-item-execution-projection.js';
import { parseExecutionManifest, readExecutionManifest, type ResolvedExecutionManifest } from './execution-manifest.js';
import { executionManifestPath, executionWorkspacePath } from '../../infrastructure/workspace.js';
import { resolveWorkflowRunRequest, type WorkflowRunRequest, type WorkflowRunCliInput } from './run-request.js';
import { withLogContext, logger } from '../../infrastructure/io/index.js';
import { RepositoryLeases } from '../../infrastructure/git/repository-lease.js';
import type { PluginRuntime } from '../plugins/runtime.js';
import { WorktreeManager } from '../../infrastructure/git/worktree.js';
import { recordExecutionExperience, recordSuccessfulExperience } from '../learning/runtime.js';
import { createFailureDiagnostic } from './failure-diagnostic.js';

export interface ExecuteWorkItemInput {
  workItemId: string;
  executionId?: string;
  manifestPath?: string;
  template?: string;
  project?: string;
  runOptions?: Omit<WorkflowRunCliInput, 'backlogId'> & { backlogId?: string };
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

async function openExecutionJournal(journalPath: string, workItemId: string, executionId: string): Promise<FileHandle> {
  try {
    return await open(journalPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  let journal: FileHandle | undefined;
  try {
    const before = await lstat(journalPath);
    const maxBytes = 64 * 1024;
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maxBytes) {
      throw new Error('journal must be a nonempty regular file of at most 64 KiB with one link');
    }
    journal = await open(journalPath, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const unchanged = (stat: typeof before) => stat.isFile() && stat.nlink === 1
      && stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size
      && stat.mtimeMs === before.mtimeMs && stat.ctimeMs === before.ctimeMs;
    if (!unchanged(await journal.stat())) throw new Error('journal changed while opening');
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await journal.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== before.size || !unchanged(await journal.stat()) || !unchanged(await lstat(journalPath))) {
      throw new Error('journal changed while reading');
    }
    const contents = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytesRead));
    if (!contents.endsWith('\n')) throw new Error('partial journal record');
    let previous: string | undefined;
    for (const line of contents.slice(0, -1).split('\n')) {
      const entry = JSON.parse(line) as {
        executionId?: unknown; workItemId?: unknown; phase?: unknown; at?: unknown; reason?: unknown;
      } | null;
      if (!entry || Array.isArray(entry) || JSON.stringify(entry) !== line
        || entry.executionId !== executionId || entry.workItemId !== workItemId
        || typeof entry.at !== 'string' || new Date(entry.at).toISOString() !== entry.at
        || (entry.phase !== 'requested' && entry.phase !== 'failed')
        || Object.keys(entry).sort().join(',') !== (entry.phase === 'requested'
          ? 'at,executionId,phase,workItemId' : 'at,executionId,phase,reason,workItemId')
        || (entry.phase === 'failed' && (previous !== 'requested' || typeof entry.reason !== 'string'))) {
        throw new Error('journal is not an intact pre-implementation attempt with matching identity');
      }
      previous = entry.phase;
    }
    return journal;
  } catch (error) {
    await journal?.close();
    throw new Error(`cannot safely retry execution journal ${executionId}`, { cause: error });
  }
}

export interface ExecuteWorkItemDependencies {
  plugins?: PluginRuntime;
  agentProviderRegistry?: AgentProviderRegistry;
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

/**
 * The work items of the item's platform, read once per attempt.
 *
 * The inventory enumerates every project the credentials reach, so reading it
 * twice for one item — once for the item and once for its PRD parent — costs
 * more than the lookup it saves.
 */
async function loadWorkItemInventory(id: string) {
  return collectGlobalWorkItemInventory(createGlobalWorkItemCatalogs(parseWorkItemId(id).platform));
}

function workItemFromInventory(
  inventory: Awaited<ReturnType<typeof loadWorkItemInventory>>,
  id: string,
): GlobalWorkItem {
  const item = inventory.items.find(candidate => candidate.id === id);
  if (!item) throw new Error(`work item ${id} is absent from global inventory${inventory.diagnostics.length ? ` (${inventory.diagnostics.map(diagnostic => diagnostic.message).join('; ')})` : ''}`);
  return item;
}

async function lookupWorkItem(id: string): Promise<GlobalWorkItem> {
  return workItemFromInventory(await loadWorkItemInventory(id), id);
}

async function resolveManifest(input: ExecuteWorkItemInput, dependencies: ExecuteWorkItemDependencies, create = true): Promise<ResolvedExecutionManifest> {
  const identity = parseWorkItemId(input.workItemId);
  const workItemId = identity.id;
  const manifestPath = input.manifestPath ?? executionManifestPath(workItemId);
  if (create && !input.manifestPath && !dependencies.readManifest) {
    try {
      await lstat(manifestPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // The inventory is read once and answers for the item and its parent:
      // both live on the same platform.
      const inventory = dependencies.lookupWorkItem ? undefined : await loadWorkItemInventory(workItemId);
      const lookup = dependencies.lookupWorkItem
        ?? (async (id: string) => workItemFromInventory(inventory!, id));
      const item = await lookup(workItemId);
      if (item.id !== workItemId || !item.managed || !item.executionEligible) throw new Error(`work item ${workItemId} is not executable`);
      const project = item.project;
      const name = project.projectKey.split('/').at(-1)!;
      // The work item body declares the ref the work starts from. The
      // repository's default branch is a setting of the repository and says
      // nothing about this piece of work — a repository can be developed on
      // `master` while the work starts from a release ref.
      const declaredPlan = parseExecutionPlan(item.description);
      const fallback = repositoryExecutionDefaults(getWorkflowConfig(), project.projectKey,
        join(executionWorkspacePath(workItemId), 'repositories', name), project.defaultBranch);
      // A slice of a PRD is written on, and merges into, that PRD's own
      // accumulation branch. Only a slice that declares its own plan keeps
      // another base.
      const prdBaseline = await resolveParentPrdBaseline(item.parentId, lookup);
      const explicitBase = input.runOptions?.baseBranch
        ?? (input.runOptions?.branchStrategy?.type === 'named' ? input.runOptions.branchStrategy.baseBranch : undefined);
      const plan = resolvePrdExecutionPlan({
        plan: declaredPlan ?? (explicitBase ? createExecutionPlan({ baseRef: explicitBase,
          targetRef: fallback.targetRef === fallback.baseRef ? explicitBase : fallback.targetRef, sourceRef: fallback.sourceRef }) : undefined),
        prdBaseline,
        fallback,
      });
      if (input.runOptions?.baseBranch && input.runOptions.baseBranch !== plan.baseRef) throw new Error('--base-branch conflicts with work item execution refs');
      const baseBranch = plan.baseRef;
      const strategy = input.runOptions?.branchStrategy;
      const workingBranch = input.runOptions?.targetBranch
        ?? (strategy?.type === 'named' || strategy?.type === 'existing' ? strategy.branch : item.branchName);
      const manifest = parseExecutionManifest({
        schemaVersion: 1, workItemId, providerBacklogId: String(item.issueNumber),
        tracker: { platform: project.platform, projectKey: project.projectKey,
          ...(project.providerHost ? { providerHost: project.providerHost } : {}),
          ...(project.providerProjectId ? { providerProjectId: project.providerProjectId } : {}) },
        workingBranch,
        repositories: [{ platform: project.platform, projectKey: project.projectKey,
          ...(project.providerHost ? { providerHost: project.providerHost } : {}),
          ...(project.providerProjectId ? { providerProjectId: project.providerProjectId } : {}),
          name, checkoutPath: `repositories/${name}`, baseBranch, targetBranch: plan.targetRef,
          ...(plan.sourceRef ? { sourceBranch: plan.sourceRef } : {}),
          // A baseline branch that is the PRD's own may be created on demand:
          // the PRD owns that branch, so it is AFK's to cut. A base branch
          // somebody declared by hand is expected to exist already.
          ...(prdBaseline && plan.baseRef === prdBaseline ? { prdBaseline: true } : {}),
          workingBranch, primary: true }],
      }, { manifestPath, backlogId: workItemId });
      await mkdir(workspaceDataDirectory(executionWorkspacePath(workItemId)), { recursive: true });
      const temporaryPath = `${manifestPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        try { await link(temporaryPath, manifestPath); }
        catch (writeError) { if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError; }
      } finally {
        await unlink(temporaryPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    }
  }
  if (create) await mkdir(executionWorkspacePath(workItemId), { recursive: true });
  return (dependencies.readManifest ?? readExecutionManifest)(manifestPath, workItemId);
}

function resolveAgentRegistry(dependencies: ExecuteWorkItemDependencies): AgentProviderRegistry {
  if (dependencies.agentProviderRegistry) return dependencies.agentProviderRegistry;
  if (dependencies.plugins) return dependencies.plugins.getAgentProviderRegistry();
  ensureBuiltinAgentProviders(defaultAgentProviderRegistry);
  return defaultAgentProviderRegistry;
}

async function createContext(manifest: ResolvedExecutionManifest, input: ExecuteWorkItemInput, config: WorkflowConfig,
  agentProviderRegistry: AgentProviderRegistry, plugins?: PluginRuntime) {
  const request = await resolveWorkflowRunRequest({
    ...input.runOptions,
    backlogId: input.workItemId,
    executionManifestPath: manifest.manifestPath,
    template: input.template,
    projectName: input.project,
    // ADR-0019 §4: managed executions are interactive tmux sessions, never
    // batch/exec. Do not "simplify" this back to 'batch'.
    executionMode: input.runOptions?.executionMode ?? 'interactive',
  }, config, { agentProviderRegistry });
  const { providers } = await assembleProviders({ workItemId: input.workItemId,
    projectId: request.trackerProjectId ?? request.projectName, projectKey: request.trackerProjectKey,
    cwd: request.repoRoot, platform: request.trackerPlatform, providerHost: request.trackerHost, plugins });
  return { request, providers };
}

function validateItem(item: BacklogItem, inventoryItem: GlobalWorkItem, manifest: ResolvedExecutionManifest, workItemId: string): void {
  const identity = parseWorkItemId(workItemId);
  if (inventoryItem.id !== workItemId
    || item.id !== workItemId
    || Number(manifest.providerBacklogId) !== identity.issueNumber
    || inventoryItem.issueNumber !== identity.issueNumber
    || inventoryItem.project.platform !== identity.platform || inventoryItem.project.projectKey !== identity.projectKey
    || (item.workItemId !== undefined && item.workItemId !== workItemId)
    || (item.issueNumber !== undefined && item.issueNumber !== identity.issueNumber)
    || (item.project !== undefined && (item.project.platform !== identity.platform || item.project.projectKey !== identity.projectKey))
    || item.providerRef !== workItemId
    || manifest.tracker.platform !== identity.platform
    || manifest.tracker.projectKey !== identity.projectKey) {
    throw new Error(`work item identity does not match provider and execution manifest: ${workItemId}`);
  }
  if (!inventoryItem.managed || item.managed === false) {
    throw new Error(
      `unmanaged work item: ${workItemId} — AFK only executes issues it manages. ` +
      `Run \`afk backlog adopt --id ${identity.issueNumber} --project ${identity.projectKey} --platform ${identity.platform}\` ` +
      `to add '${BACKLOG_METADATA.stateLabels.ready}' and '${BACKLOG_METADATA.executionModeLabels.afk}', ` +
      `or create it through the backlog so they are applied automatically.`,
    );
  }
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
  return withLogContext(context, () => executeWorkItemObserved(input, dependencies, context));
}

async function executeWorkItemObserved(input: ExecuteWorkItemInput, dependencies: ExecuteWorkItemDependencies, context: ObservationContext): Promise<ExecuteWorkItemResult> {
  const workItemId = parseWorkItemId(context.workItemId).id;
  const executionId = context.runId;
  const observer = dependencies.recordAudit ? undefined : createPluginRunObserver(dependencies.plugins);
  const recordAudit = dependencies.recordAudit ?? ((auditContext: ObservationContext, data: RunEventData) => observer!.record(auditContext, data));
  const audit = async (data: RunEventData) => {
    await recordAudit(context, data);
    if (data.kind === 'qa.failed') {
      try {
        recordExecutionExperience({ runId: context.runId, workItemId, sourceEvent: 'qa.failed',
          failure: createFailureDiagnostic({ code: data.reasonCode ?? (data.reason === 'rework' ? 'qa_rework' : 'qa_execution_failed'),
            message: data.summary ?? `Independent QA ${data.reason ?? 'failed'}` }) });
      } catch { logger.warn({ workItemId, runId: context.runId }, 'QA failure experience could not be recorded'); }
    }
    if ((data.kind === 'human_gate.opened' && data.gateId.startsWith('merge:')) || (data.kind === 'run.finished' && data.outcome === 'succeeded')) {
      try { await recordSuccessfulExperience({ runId: context.runId, workItemId }); }
      catch { logger.warn({ workItemId, runId: context.runId }, 'Successful workflow experience could not be recorded'); }
    }
  };
  const manifest = await resolveManifest(input, dependencies);
  return new RepositoryLeases().run((manifest.repositories ?? []).map(repository => `${repository.platform}:${repository.projectKey}`), async () => {
    const directory = join(workspaceDataDirectory(manifest.workspaceRoot), 'executions');
    await mkdir(directory, { recursive: true });
    const lockPath = join(directory, `${encodeWorkItemIdForPath(workItemId)}.lock`);
    const lock = await acquireLock(lockPath, workItemId, executionId, dependencies.lockProbe ?? defaultLockProbe);
    try {
      const journal = await openExecutionJournal(join(directory, `${executionId}.jsonl`), workItemId, executionId);
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
          const agentProviderRegistry = resolveAgentRegistry(dependencies);
          const { request, providers } = await (dependencies.createContext
            ? dependencies.createContext(manifest, input, config)
            : createContext(manifest, input, config, agentProviderRegistry, dependencies.plugins));
          if (request.backlogId !== manifest.providerBacklogId) throw new Error('resolved request backlog identity mismatch');
          const item = await providers.backlog.get(request.backlogId);
          const inventoryItem = await (dependencies.lookupWorkItem ?? lookupWorkItem)(workItemId);
          validateItem(item, inventoryItem, manifest, workItemId);
          const declared = parseExecutionPlan(item.description);
          if (declared && request.executionPlan && (declared.baseRef !== request.executionPlan.baseRef
            || declared.targetRef !== request.executionPlan.targetRef || declared.sourceRef !== request.executionPlan.sourceRef)) {
            throw new Error('work item execution refs conflict with the execution manifest');
          }
          for (const dependencyId of item.dependsOn) {
            const dependency = await providers.backlog.get(dependencyId);
            if (dependency.state !== 'done') throw new Error(`unmet dependency ${dependencyId}`);
          }
          if (!(await providers.backlog.isRunnable(item))) throw new Error(`work item ${workItemId} has unmet dependencies or is not runnable`);
          const existing = await providers.changes.findForBacklog(item);
          if (existing?.state === 'open') {
            // A previous attempt can leave a review request behind. A work item
            // that is being reworked is expected to have one: the verification
            // reuses it and refreshes its evidence rather than asking the
            // reviewer for a second one. A work item that never ran is not.
            if (item.state !== 'rework') {
              throw new Error(`work item already has an open change request: ${existing.url ?? existing.id}`);
            }
            logger.info({ workItemId, changeId: existing.id }, 'reusing the change request of an earlier attempt');
          }
          request.agentRuntime = await prepareAgentRuntime(request.agentRuntime);
          await record('implementing');
          const implementation = (dependencies.createImplementation ?? ((bundle, workflowConfig, runRequest) =>
            new WorkflowRunner(bundle, { config: workflowConfig, plugins: dependencies.plugins, agentRuntime: runRequest.agentRuntime, agentProviderRegistry, observer: createPluginRunObserver(dependencies.plugins) })))(providers, config, request);
          const implementationResult = await implementation.run({ ...request, template: input.template ?? request.template, session: executionId,
            executionMode: input.runOptions?.executionMode === undefined ? 'interactive' : request.executionMode,
            observationRunId: executionId, observationWorkItemId: workItemId, auditRequired: true });
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
          const management = asManagementProviders(providers);
          const qa = (dependencies.createQA ?? ((bundle, workflowConfig, runRequest) =>
            new QARunner(bundle, workflowConfig, {
              plugins: dependencies.plugins,
              agentProviderRegistry,
              agentProvider: agentProviderRegistry.require(runRequest.agentProvider ?? workflowConfig.agentDefault ?? 'claude-code'),
              sandboxProvider: dependencies.plugins?.getSandboxProviderRegistry().create(runRequest.sandboxProvider ?? 'local', {
                worktreeManager: new WorktreeManager(),
              }),
              agentRuntime: runRequest.agentRuntime, executionMode: input.runOptions?.executionMode === undefined ? 'interactive' : runRequest.executionMode, projectRoot: runRequest.workspaceRoot,
              repositories: runRequest.repositories,
              executionBaseBranch: runRequest.executionBaseBranch,
              executionPlan: runRequest.executionPlan,
              beforeChange: async () => {
                await auditQAPass();
                await record('publication_requested', {});
              },
              afterPublication: async change => {
                await providers.changes.verifyIssueAssociation(change, workItemId);
                await record('published', { changeId: change.id, changeUrl: change.url });
              },
              onCommit: (commitSha, branch) => audit({ kind: 'commit.recorded', phase: 'qa', commitSha, branch }),
              onSession: audit,
            })))(management, config, request);
          const qaResult = await qa.process(request.backlogId).catch(async error => {
            await audit({
              kind: 'qa.failed', reason: 'blocked',
              summary: `QA execution failed: ${error instanceof Error ? error.message : String(error)}`,
            }).catch(() => undefined);
            throw error;
          });
          if (qaResult.success) await auditQAPass();
          else await audit({
            kind: 'qa.failed',
            reason: qaResult.rework ? 'rework' : 'blocked',
            ...((qaResult.failureCode ?? (qaResult.rework ? 'qa_rework' : undefined))
              ? { reasonCode: qaResult.failureCode ?? 'qa_rework' }
              : {}),
            ...(qaResult.summary ? { summary: qaResult.summary } : {}),
            ...(qaResult.failedCriteria ? { failedCriteria: qaResult.failedCriteria } : {}),
            ...(qaResult.evidence ? { evidence: qaResult.evidence } : {}),
          });
          const change = qaResult.success ? await providers.changes.findForBacklog(item) : null;
          const finalItem = qaResult.success ? await providers.backlog.get(request.backlogId) : null;
          const published = change && change.id && change.url && change.url === qaResult.mrUrl
            && (change.state === 'open' || change.state === 'merged');
          if (published) await providers.changes.verifyIssueAssociation(change, workItemId);
          // The change is published and waits for a person to confirm the merge.
          // A child waits exactly like a root does, so the shape of the
          // outcome no longer depends on where the item sits in the tree.
          const awaitingHumanMerge = change?.state === 'open' && finalItem?.state === 'merge_ready';
          const status: ExecuteWorkItemStatus = qaResult.success && published && awaitingHumanMerge
            ? 'merge_ready'
            : qaResult.rework ? 'rework' : 'blocked';
          if (status === 'merge_ready') {
            await audit({ kind: 'change.published', changeId: String(change!.id), url: change!.url! });
            await audit({ kind: 'human_gate.opened', gateId: `merge:${change!.id}`, reason: 'awaiting human merge' });
          } else await audit({
            kind: 'run.finished',
            outcome: 'failed',
            // The root cause, not a fixed phrase: the summary is what the QA
            // runner diagnosed, and it is the only thing here that says why.
            reason: qaResult.summary ?? (status === 'rework' ? 'QA requested rework' : 'QA or provider change not confirmed'),
            reasonCode: qaResult.failureCode ?? (status === 'rework' ? 'qa_rework' : 'provider_change_unconfirmed'),
          });
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
  }, (input.runOptions?.executionMode ?? 'interactive') === 'interactive'
    && (input.runOptions?.agentProvider ?? getWorkflowConfig().agentDefault) === 'claude-code'
    && (input.runOptions?.sandboxProvider ?? 'local') === 'local');
}

async function journalPublication(manifest: ResolvedExecutionManifest, executionId: string, workItemId: string): Promise<{ requested: boolean; published?: { id: string; url: string } }> {
  let contents: string;
  try {
    contents = await readFile(join(workspaceDataDirectory(manifest.workspaceRoot), 'executions', `${executionId}.jsonl`), 'utf8');
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
  const manifest = await resolveManifest(input, dependencies, false);
  const lockPath = join(workspaceDataDirectory(manifest.workspaceRoot), 'executions', `${encodeWorkItemIdForPath(workItemId)}.lock`);
  await mkdir(join(workspaceDataDirectory(manifest.workspaceRoot), 'executions'), { recursive: true });
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
    const config = getWorkflowConfig();
    const { request, providers } = await (dependencies.createContext
      ? dependencies.createContext(manifest, input, config)
      : createContext(manifest, input, config, resolveAgentRegistry(dependencies), dependencies.plugins));
    if (request.backlogId !== manifest.providerBacklogId) throw new Error('resolved request backlog identity mismatch');
    const item = await providers.backlog.get(request.backlogId);
    if (item.parentId || item.id !== workItemId
      || (item.workItemId !== undefined && item.workItemId !== workItemId)
      || item.providerRef !== workItemId
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
      || change.targetBranch !== (request.executionPlan?.targetRef ?? request.executionBaseBranch ?? request.targetBranch)) {
      throw new Error('provider change request identity mismatch');
    }
    if (change.state !== 'open' && change.state !== 'merged') throw new Error('provider change request is closed without merge');
    if (item.state === 'done' && change.state !== 'merged') throw new Error('backlog is done without a merged provider change request');
    await providers.changes.verifyIssueAssociation(change, workItemId);
    const observer = dependencies.recordAudit ? undefined : createPluginRunObserver(dependencies.plugins);
    const recordAudit = dependencies.recordAudit ?? ((context: ObservationContext, data: RunEventData) => observer!.record(context, data));
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
