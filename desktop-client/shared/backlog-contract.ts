/**
 * Provider-neutral backlog DTOs shared between the Electron main process
 * and the React renderer. The desktop client treats these as wire format
 * only — no Node / Electron / React / DOM / filesystem imports allowed.
 *
 * The shape mirrors the AFK CLI domain (src/domain/backlog/types.ts) but
 * is intentionally decoupled: a future provider that AFK supports
 * (Linear, Jira) can be added here without touching the renderer code
 * beyond an icon and a label.
 */

export const BACKLOG_STATES = [
  "ready",
  "rework",
  "in_progress",
  "verification",
  "merge_ready",
  "done",
  "blocked",
] as const;

export type BacklogState = typeof BACKLOG_STATES[number];

export const BACKLOG_EXECUTION_MODES = ["afk", "hitl"] as const;
export type BacklogExecutionMode = typeof BACKLOG_EXECUTION_MODES[number];

export const BACKLOG_PLATFORMS = ["github", "gitlab"] as const;
export type BacklogPlatform = typeof BACKLOG_PLATFORMS[number];
export type WorkItemId = string;

export type ProviderProjectRef = {
  platform: BacklogPlatform;
  projectKey: string;
  providerProjectId?: string;
  name: string;
  defaultBranch?: string;
  webUrl?: string;
};

export type WorkItemSourceRef = {
  id: string;
  type: "github_issue" | "gitlab_issue" | "external" | "local";
  title: string;
  reference: string;
  role?: string;
  platform?: BacklogPlatform;
  projectKey?: string;
  issueNumber?: number;
  webUrl?: string;
};

export type WorkItemRepositoryRef = ProviderProjectRef & {
  id?: string;
  role?: string;
  checkoutPath?: string;
  /** Derived: defaultBranch || "main" */
  baseBranch: string;
};

export type WorkItemExecutionStep = {
  id: string;
  title: string;
  detail?: string;
  status?: "pending" | "running" | "completed" | "blocked";
};

export type WorkItemRunRecord = {
  id: string;
  status: "starting" | "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  workflow?: string;
  workspacePath?: string;
  pid?: number;
  error?: string;
};

export type WorkItemRunStartInput = {
  workItemId: WorkItemId;
  repositories: WorkItemRepositoryRef[];
  workflow?: string;
  environment?: "local";
};

export type WorkItemRunStartResult = {
  runId: string;
  workspace: {
    root: string;
  };
};

export type GlobalWorkItem = {
  id: WorkItemId;
  /** @deprecated Compatibility projection for issue-backed inventory entries. */
  issueNumber: number;
  /** @deprecated Compatibility projection for issue-backed inventory entries. */
  project: ProviderProjectRef;
  title: string;
  description?: string;
  managed: boolean;
  executionEligible: boolean;
  state: BacklogState;
  executionMode: BacklogExecutionMode;
  parentId?: WorkItemId;
  dependsOn: WorkItemId[];
  tags: string[];
  branchName: string;
  providerRef: string;
  webUrl?: string;
  sources?: WorkItemSourceRef[];
  repositories?: WorkItemRepositoryRef[];
  executionPlan?: WorkItemExecutionStep[];
  runs?: WorkItemRunRecord[];
  owner?: string;
  priority?: "P0" | "P1" | "P2" | "P3";
  updatedAt?: string;
};

export type WorkItemInventoryOptions = {
  platform?: BacklogPlatform | "all";
  state?: BacklogState;
  executionMode?: BacklogExecutionMode;
  tag?: string;
  project?: string;
};

export type WorkItemInventoryDiagnostic = {
  platform: BacklogPlatform;
  projectKey?: string;
  code: string;
  message: string;
  retryable: boolean;
};

export type WorkItemInventoryResult = {
  items: GlobalWorkItem[];
  projects: ProviderProjectRef[];
  diagnostics: WorkItemInventoryDiagnostic[];
  complete: boolean;
};

export type BacklogItem = {
  id: string;
  workItemId?: WorkItemId;
  issueNumber?: number;
  project?: ProviderProjectRef;
  managed?: boolean;
  executionEligible?: boolean;
  title: string;
  description?: string;
  parentId?: string;
  baseBacklogId?: string;
  dependsOn: string[];
  state: BacklogState;
  executionMode: BacklogExecutionMode;
  tags: string[];
  branchName: string;
  providerRef: string;
  webUrl?: string;
};

export type BacklogListOptions = {
  state?: BacklogState;
  executionMode?: BacklogExecutionMode;
  parentId?: string;
  tag?: string;
  platform?: BacklogPlatform;
};

export type BacklogCreateInput = {
  title: string;
  description: string;
  parentId?: string;
  baseBacklogId?: string;
  dependsOn?: string[];
  executionMode?: BacklogExecutionMode;
  tags?: string[];
  platform?: BacklogPlatform;
};

export type BacklogRunStartInput = {
  backlogId: string;
  template?: string;
};

export type BacklogRunRetryInput = BacklogRunStartInput & {
  reason: string;
};

export type BacklogRunSummary = {
  id: string;
  backlogId: string;
  status: "starting" | "running" | "completed" | "failed";
  startedAt: string;
  template?: string;
  pid?: number;
  error?: string;
};

export type BacklogRuntimeStatus = "running" | "stale" | "completed" | "blocked" | "failed";

export type BacklogRuntimeProjection = {
  runId: string;
  status: BacklogRuntimeStatus;
  phase: "implementing" | "verifying";
  progress?: string;
  branch?: string;
  worktree?: string;
  diagnosticPath?: string;
  heartbeatAt: string;
};

export type BacklogRuntimeSummary = {
  backlogId: string;
  backlog: BacklogItem;
  activeRun?: BacklogRunSummary;
  runtime?: BacklogRuntimeProjection;
};

export type BacklogErrorCode =
  | "auth"
  | "not_found"
  | "validation"
  | "provider"
  | "unknown";

export type BacklogError = {
  code: BacklogErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

/**
 * Strict parser for backlog list options. Throws on unknown keys, wrong
 * types, or out-of-enum values. The renderer side never sees untyped
 * data; the main process uses this at the IPC boundary so a malformed
 * payload cannot reach the AFK CLI subprocess.
 */
export function parseBacklogListOptions(input: unknown): BacklogListOptions {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("backlog list options must be an object");
  const candidate = input as Record<string, unknown>;
  const allowed = new Set(["state", "executionMode", "parentId", "tag", "platform"]);
  for (const key of Object.keys(candidate)) {
    if (!allowed.has(key)) throw new Error(`backlog list options has unknown field: ${key}`);
  }
  const result: BacklogListOptions = {};
  if ("state" in candidate) {
    if (typeof candidate.state !== "string") throw new Error("backlog list options: state must be a string");
    if (!BACKLOG_STATES.includes(candidate.state as BacklogState)) throw new Error(`backlog list options: invalid state ${candidate.state}`);
    result.state = candidate.state as BacklogState;
  }
  if ("executionMode" in candidate) {
    if (typeof candidate.executionMode !== "string") throw new Error("backlog list options: executionMode must be a string");
    if (!BACKLOG_EXECUTION_MODES.includes(candidate.executionMode as BacklogExecutionMode)) {
      throw new Error(`backlog list options: invalid executionMode ${candidate.executionMode}`);
    }
    result.executionMode = candidate.executionMode as BacklogExecutionMode;
  }
  if ("parentId" in candidate) {
    if (typeof candidate.parentId !== "string") throw new Error("backlog list options: parentId must be a string");
    result.parentId = candidate.parentId;
  }
  if ("tag" in candidate) {
    if (typeof candidate.tag !== "string") throw new Error("backlog list options: tag must be a string");
    result.tag = candidate.tag;
  }
  if ("platform" in candidate) {
    result.platform = parseBacklogPlatform(candidate.platform);
  }
  return result;
}

export function parseBacklogCreateInput(input: unknown): BacklogCreateInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("backlog create input must be an object");
  const candidate = input as Record<string, unknown>;
  if (typeof candidate.title !== "string" || !candidate.title.trim()) throw new Error("backlog create input: title is required");
  if (typeof candidate.description !== "string" || !candidate.description.trim()) throw new Error("backlog create input: description is required");
  const result: BacklogCreateInput = {
    title: candidate.title.trim(),
    description: candidate.description,
  };
  if ("parentId" in candidate) {
    if (typeof candidate.parentId !== "string") throw new Error("backlog create input: parentId must be a string");
    result.parentId = candidate.parentId;
  }
  if ("baseBacklogId" in candidate) {
    if (typeof candidate.baseBacklogId !== "string") throw new Error("backlog create input: baseBacklogId must be a string");
    result.baseBacklogId = candidate.baseBacklogId;
  }
  if ("dependsOn" in candidate) {
    if (!Array.isArray(candidate.dependsOn) || candidate.dependsOn.some(item => typeof item !== "string")) {
      throw new Error("backlog create input: dependsOn must be a string array");
    }
    result.dependsOn = candidate.dependsOn as string[];
  }
  if ("executionMode" in candidate) {
    if (typeof candidate.executionMode !== "string" || !BACKLOG_EXECUTION_MODES.includes(candidate.executionMode as BacklogExecutionMode)) {
      throw new Error("backlog create input: executionMode is invalid");
    }
    result.executionMode = candidate.executionMode as BacklogExecutionMode;
  }
  if ("tags" in candidate) {
    if (!Array.isArray(candidate.tags) || candidate.tags.some(item => typeof item !== "string")) {
      throw new Error("backlog create input: tags must be a string array");
    }
    result.tags = candidate.tags as string[];
  }
  if ("platform" in candidate) result.platform = parseBacklogPlatform(candidate.platform);
  return result;
}

export function parseBacklogRunStartInput(input: unknown): BacklogRunStartInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("backlog run input must be an object");
  const candidate = input as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.some((key) => key !== "backlogId" && key !== "template")) throw new Error("backlog run input has unknown fields");
  const result: BacklogRunStartInput = { backlogId: parseBacklogId(candidate.backlogId) };
  if (candidate.template !== undefined) {
    if (typeof candidate.template !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(candidate.template)) throw new Error("backlog run input: template is invalid");
    result.template = candidate.template;
  }
  return result;
}

export function parseBacklogRunRetryInput(input: unknown): BacklogRunRetryInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("backlog retry input must be an object");
  const candidate = input as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => key !== "backlogId" && key !== "template" && key !== "reason")) throw new Error("backlog retry input has unknown fields");
  const start = parseBacklogRunStartInput({ backlogId: candidate.backlogId, ...(candidate.template === undefined ? {} : { template: candidate.template }) });
  if (typeof candidate.reason !== "string" || !candidate.reason.trim() || /[\x00-\x1f\x7f]/.test(candidate.reason) || candidate.reason.length > 1000) throw new Error("backlog retry input: reason is invalid");
  return { ...start, reason: candidate.reason.trim() };
}

export function parseWorkItemRunStartInput(input: unknown): WorkItemRunStartInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("work item run input must be an object");
  const candidate = input as Record<string, unknown>;
  assertExactKeys(candidate, ["workItemId", "repositories", "workflow", "environment"], "work item run input");
  if (!Array.isArray(candidate.repositories)) throw new Error("work item run input: repositories must be an array");
  const result: WorkItemRunStartInput = {
    workItemId: parseGlobalWorkItemIdentity(candidate.workItemId, "work item run input: workItemId"),
    repositories: candidate.repositories.map(parseWorkItemRepository),
  };
  if (candidate.workflow !== undefined) {
    if (typeof candidate.workflow !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(candidate.workflow)) throw new Error("work item run input: workflow is invalid");
    result.workflow = candidate.workflow;
  }
  if (candidate.environment !== undefined) {
    if (candidate.environment !== "local") throw new Error("work item run input: environment is invalid");
    result.environment = "local";
  }
  return result;
}

export function parseBacklogId(input: unknown): string {
  if (typeof input !== "string") throw new Error("backlogId must be a string");
  const value = input.trim();
  if (!value || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("backlogId is invalid");
  return value;
}

export function formatWorkItemId(input: { platform: BacklogPlatform; projectKey: string; issueNumber: number }): WorkItemId {
  const platform = parseRequiredBacklogPlatform(input.platform, "work item ID");
  const projectKey = parseProjectKey(input.projectKey, "work item ID");
  const issueNumber = parseIssueNumber(input.issueNumber, "work item ID");
  return `${platform}:${projectKey}#${issueNumber}`;
}

export function parseWorkItemId(input: unknown): WorkItemId {
  if (typeof input !== "string" || input.trim() !== input) throw new Error("work item ID must be a canonical string");
  const match = /^([^:]+):([^#]+)#([1-9]\d*)$/.exec(input);
  if (!match) throw new Error("work item ID must use platform:projectKey#issueNumber");
  const id = formatWorkItemId({
    platform: parseRequiredBacklogPlatform(match[1], "work item ID"),
    projectKey: match[2],
    issueNumber: Number(match[3]),
  });
  if (id !== input) throw new Error("work item ID is not canonical");
  return id;
}

export function parseProviderProjectRef(input: unknown): ProviderProjectRef {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("provider project must be an object");
  const candidate = input as Record<string, unknown>;
  assertExactKeys(candidate, ["platform", "projectKey", "providerProjectId", "name", "defaultBranch", "webUrl"], "provider project");
  const project: ProviderProjectRef = {
    platform: parseRequiredBacklogPlatform(candidate.platform, "provider project"),
    projectKey: parseProjectKey(candidate.projectKey, "provider project"),
    name: parseRequiredString(candidate.name, "provider project: name"),
  };
  for (const key of ["providerProjectId", "defaultBranch", "webUrl"] as const) {
    if (candidate[key] !== undefined) project[key] = parseRequiredString(candidate[key], `provider project: ${key}`);
  }
  return project;
}

export function parseGlobalWorkItem(input: unknown): GlobalWorkItem {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("global work item must be an object");
  const candidate = input as Record<string, unknown>;
  assertExactKeys(candidate, ["id", "issueNumber", "project", "title", "description", "managed", "executionEligible", "state", "executionMode", "parentId", "dependsOn", "tags", "branchName", "providerRef", "webUrl", "sources", "repositories", "executionPlan", "runs", "owner", "priority", "updatedAt"], "global work item");
  const id = parseGlobalWorkItemIdentity(candidate.id, "global work item: id");
  const issueNumber = parseIssueNumber(candidate.issueNumber, "global work item");
  const project = parseProviderProjectRef(candidate.project);
  if (/^[^:]+:[^#]+#[1-9]\d*$/.test(id)) assertWorkItemIdentityMatches(parseWorkItemId(id), issueNumber, project, "global work item");
  if (typeof candidate.managed !== "boolean" || typeof candidate.executionEligible !== "boolean") throw new Error("global work item: managed and executionEligible must be booleans");
  if (candidate.executionEligible && !candidate.managed) throw new Error("global work item: unmanaged items cannot be execution eligible");
  if (!isBacklogState(candidate.state) || !isBacklogExecutionMode(candidate.executionMode)) throw new Error("global work item has invalid lifecycle fields");
  if (!Array.isArray(candidate.dependsOn)) throw new Error("global work item: dependsOn must be an array");
  if (!Array.isArray(candidate.tags) || candidate.tags.some(value => typeof value !== "string")) throw new Error("global work item: tags is invalid");
  const result: GlobalWorkItem = {
    id,
    issueNumber,
    project,
    title: parseRequiredString(candidate.title, "global work item: title"),
    managed: candidate.managed,
    executionEligible: candidate.executionEligible,
    state: candidate.state,
    executionMode: candidate.executionMode,
    dependsOn: candidate.dependsOn.map(value => parseGlobalWorkItemIdentity(value, "global work item: dependsOn")),
    tags: candidate.tags as string[],
    branchName: parseRequiredString(candidate.branchName, "global work item: branchName"),
    providerRef: parseRequiredString(candidate.providerRef, "global work item: providerRef"),
  };
  if (candidate.description !== undefined) result.description = parseMultilineString(candidate.description, "global work item: description");
  if (candidate.parentId !== undefined) result.parentId = parseGlobalWorkItemIdentity(candidate.parentId, "global work item: parentId");
  if (candidate.webUrl !== undefined) result.webUrl = parseRequiredString(candidate.webUrl, "global work item: webUrl");
  if (candidate.sources !== undefined) result.sources = parseWorkItemArray(candidate.sources, parseWorkItemSource, "global work item: sources");
  if (candidate.repositories !== undefined) result.repositories = parseWorkItemArray(candidate.repositories, parseWorkItemRepository, "global work item: repositories");
  if (candidate.executionPlan !== undefined) result.executionPlan = parseWorkItemArray(candidate.executionPlan, parseWorkItemExecutionStep, "global work item: executionPlan");
  if (candidate.runs !== undefined) result.runs = parseWorkItemArray(candidate.runs, parseWorkItemRunRecord, "global work item: runs");
  if (candidate.owner !== undefined) result.owner = parseRequiredString(candidate.owner, "global work item: owner");
  if (candidate.priority !== undefined) {
    if (typeof candidate.priority !== "string" || !["P0", "P1", "P2", "P3"].includes(candidate.priority)) throw new Error("global work item: priority is invalid");
    result.priority = candidate.priority as GlobalWorkItem["priority"];
  }
  if (candidate.updatedAt !== undefined) result.updatedAt = parseRequiredString(candidate.updatedAt, "global work item: updatedAt");
  return result;
}

function parseGlobalWorkItemIdentity(input: unknown, label: string): WorkItemId {
  if (typeof input !== "string" || input.trim() !== input || !input || input.length > 160 || /[\x00-\x1f\x7f]/.test(input)) throw new Error(`${label} is invalid`);
  if (/^[^:]+:[^#]+#[1-9]\d*$/.test(input)) return parseWorkItemId(input);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input) || input.includes("..")) throw new Error(`${label} is invalid`);
  return input;
}

function parseWorkItemArray<T>(input: unknown, parser: (value: unknown) => T, label: string): T[] {
  if (!Array.isArray(input)) throw new Error(`${label} must be an array`);
  return input.map(parser);
}

function parseWorkItemSource(input: unknown): WorkItemSourceRef {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("work item source must be an object");
  const candidate = input as Record<string, unknown>;
  assertExactKeys(candidate, ["id", "type", "title", "reference", "role", "platform", "projectKey", "issueNumber", "webUrl"], "work item source");
  if (typeof candidate.type !== "string" || !["github_issue", "gitlab_issue", "external", "local"].includes(candidate.type)) throw new Error("work item source: type is invalid");
  const result: WorkItemSourceRef = {
    id: parseRequiredString(candidate.id, "work item source: id"),
    type: candidate.type as WorkItemSourceRef["type"],
    title: parseRequiredString(candidate.title, "work item source: title"),
    reference: parseRequiredString(candidate.reference, "work item source: reference"),
  };
  if (candidate.role !== undefined) result.role = parseRequiredString(candidate.role, "work item source: role");
  if (candidate.platform !== undefined) result.platform = parseRequiredBacklogPlatform(candidate.platform, "work item source");
  if (candidate.projectKey !== undefined) result.projectKey = parseProjectKey(candidate.projectKey, "work item source");
  if (candidate.issueNumber !== undefined) result.issueNumber = parseIssueNumber(candidate.issueNumber, "work item source");
  if (candidate.webUrl !== undefined) result.webUrl = parseRequiredString(candidate.webUrl, "work item source: webUrl");
  return result;
}

function parseWorkItemRepository(input: unknown): WorkItemRepositoryRef {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("work item repository must be an object");
  const candidate = input as Record<string, unknown>;
  assertExactKeys(candidate, ["id", "platform", "projectKey", "providerProjectId", "name", "defaultBranch", "webUrl", "role", "checkoutPath", "baseBranch"], "work item repository");
  const project = parseProviderProjectRef({
    platform: candidate.platform,
    projectKey: candidate.projectKey,
    providerProjectId: candidate.providerProjectId,
    name: candidate.name,
    defaultBranch: candidate.defaultBranch,
    webUrl: candidate.webUrl,
  });
  return {
    ...project,
    ...(candidate.id === undefined ? {} : { id: parseRequiredString(candidate.id, "work item repository: id") }),
    ...(candidate.role === undefined ? {} : { role: parseRequiredString(candidate.role, "work item repository: role") }),
    ...(candidate.checkoutPath === undefined ? {} : { checkoutPath: parseRequiredString(candidate.checkoutPath, "work item repository: checkoutPath") }),
    baseBranch: typeof candidate.baseBranch === "string" ? candidate.baseBranch : (project.defaultBranch || "main"),
  };
}

function parseWorkItemExecutionStep(input: unknown): WorkItemExecutionStep {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("work item execution step must be an object");
  const candidate = input as Record<string, unknown>;
  assertExactKeys(candidate, ["id", "title", "detail", "status"], "work item execution step");
  if (candidate.status !== undefined && (typeof candidate.status !== "string" || !["pending", "running", "completed", "blocked"].includes(candidate.status))) throw new Error("work item execution step: status is invalid");
  return {
    id: parseRequiredString(candidate.id, "work item execution step: id"),
    title: parseRequiredString(candidate.title, "work item execution step: title"),
    ...(candidate.detail === undefined ? {} : { detail: parseRequiredString(candidate.detail, "work item execution step: detail") }),
    ...(candidate.status === undefined ? {} : { status: candidate.status as WorkItemExecutionStep["status"] }),
  };
}

function parseWorkItemRunRecord(input: unknown): WorkItemRunRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("work item run record must be an object");
  const candidate = input as Record<string, unknown>;
  assertExactKeys(candidate, ["id", "status", "startedAt", "completedAt", "workflow", "workspacePath", "pid", "error"], "work item run record");
  if (typeof candidate.status !== "string" || !["starting", "running", "completed", "failed"].includes(candidate.status)) throw new Error("work item run record: status is invalid");
  if (candidate.pid !== undefined && (typeof candidate.pid !== "number" || !Number.isInteger(candidate.pid) || candidate.pid <= 0)) throw new Error("work item run record: pid is invalid");
  return {
    id: parseRequiredString(candidate.id, "work item run record: id"),
    status: candidate.status as WorkItemRunRecord["status"],
    startedAt: parseRequiredString(candidate.startedAt, "work item run record: startedAt"),
    ...(candidate.completedAt === undefined ? {} : { completedAt: parseRequiredString(candidate.completedAt, "work item run record: completedAt") }),
    ...(candidate.workflow === undefined ? {} : { workflow: parseRequiredString(candidate.workflow, "work item run record: workflow") }),
    ...(candidate.workspacePath === undefined ? {} : { workspacePath: parseRequiredString(candidate.workspacePath, "work item run record: workspacePath") }),
    ...(candidate.pid === undefined ? {} : { pid: candidate.pid }),
    ...(candidate.error === undefined ? {} : { error: parseRequiredString(candidate.error, "work item run record: error") }),
  };
}

export function parseWorkItemInventoryOptions(input: unknown): WorkItemInventoryOptions {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("work item inventory options must be an object");
  const candidate = input as Record<string, unknown>;
  assertExactKeys(candidate, ["platform", "state", "executionMode", "tag", "project"], "work item inventory options");
  const result: WorkItemInventoryOptions = {};
  if (candidate.platform !== undefined) {
    if (candidate.platform !== "all" && !isBacklogPlatform(candidate.platform)) throw new Error("work item inventory options: invalid platform");
    result.platform = candidate.platform;
  }
  if (candidate.state !== undefined) {
    if (!isBacklogState(candidate.state)) throw new Error("work item inventory options: invalid state");
    result.state = candidate.state;
  }
  if (candidate.executionMode !== undefined) {
    if (!isBacklogExecutionMode(candidate.executionMode)) throw new Error("work item inventory options: invalid execution mode");
    result.executionMode = candidate.executionMode;
  }
  for (const key of ["tag", "project"] as const) {
    if (candidate[key] !== undefined) result[key] = parseRequiredString(candidate[key], `work item inventory options: ${key}`);
  }
  return result;
}

export function parseWorkItemInventoryResult(input: unknown): WorkItemInventoryResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("work item inventory result must be an object");
  const candidate = input as Record<string, unknown>;
  assertExactKeys(candidate, ["items", "projects", "diagnostics", "complete"], "work item inventory result");
  if (!Array.isArray(candidate.items) || !Array.isArray(candidate.projects) || !Array.isArray(candidate.diagnostics)) throw new Error("work item inventory result arrays are invalid");
  if (typeof candidate.complete !== "boolean") throw new Error("work item inventory result: complete must be boolean");
  const diagnostics = candidate.diagnostics.map((value): WorkItemInventoryDiagnostic => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("work item inventory diagnostic must be an object");
    const diagnostic = value as Record<string, unknown>;
    assertExactKeys(diagnostic, ["platform", "projectKey", "code", "message", "retryable"], "work item inventory diagnostic");
    if (!isBacklogPlatform(diagnostic.platform) || typeof diagnostic.retryable !== "boolean") throw new Error("work item inventory diagnostic has invalid fields");
    return {
      platform: diagnostic.platform,
      ...(diagnostic.projectKey === undefined ? {} : { projectKey: parseProjectKey(diagnostic.projectKey, "work item inventory diagnostic") }),
      code: parseRequiredString(diagnostic.code, "work item inventory diagnostic: code"),
      message: parseRequiredString(diagnostic.message, "work item inventory diagnostic: message"),
      retryable: diagnostic.retryable,
    };
  });
  return {
    items: candidate.items.map(parseGlobalWorkItem),
    projects: candidate.projects.map(parseProviderProjectRef),
    diagnostics,
    complete: candidate.complete,
  };
}

export function parseBacklogRuntimeSummary(input: unknown): BacklogRuntimeSummary {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("backlog runtime summary must be an object");
  const candidate = input as Record<string, unknown>;
  assertExactKeys(candidate, ["backlogId", "backlog", "activeRun", "runtime"], "backlog runtime summary");
  if (typeof candidate.backlogId !== "string" || !candidate.backlogId) throw new Error("backlog runtime summary: backlogId is required");
  const backlog = parseBacklogItem(candidate.backlog);
  if (backlog.id !== candidate.backlogId) throw new Error("backlog runtime summary: backlogId does not match backlog.id");
  const activeRun = candidate.activeRun === undefined ? undefined : parseBacklogRunSummary(candidate.activeRun);
  if (activeRun && activeRun.backlogId !== candidate.backlogId) throw new Error("backlog runtime summary: activeRun.backlogId does not match backlogId");
  return {
    backlogId: candidate.backlogId,
    backlog,
    ...(activeRun === undefined ? {} : { activeRun }),
    ...(candidate.runtime === undefined ? {} : { runtime: parseBacklogRuntimeProjection(candidate.runtime) }),
  };
}

function parseBacklogItem(input: unknown): BacklogItem {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("backlog runtime summary: backlog is invalid");
  const candidate = input as Record<string, unknown>;
  assertExactKeys(candidate, ["id", "workItemId", "issueNumber", "project", "managed", "executionEligible", "title", "description", "parentId", "baseBacklogId", "dependsOn", "state", "executionMode", "tags", "branchName", "providerRef", "webUrl"], "backlog item");
  if (typeof candidate.id !== "string" || typeof candidate.title !== "string" || typeof candidate.branchName !== "string" || typeof candidate.providerRef !== "string" || !isBacklogState(candidate.state) || !isBacklogExecutionMode(candidate.executionMode)) throw new Error("backlog item has invalid identity or enum fields");
  if (!Array.isArray(candidate.dependsOn) || candidate.dependsOn.some(value => typeof value !== "string")) throw new Error("backlog item: dependsOn is invalid");
  if (!Array.isArray(candidate.tags) || candidate.tags.some(value => typeof value !== "string")) throw new Error("backlog item: tags is invalid");
  for (const key of ["description", "parentId", "baseBacklogId", "branchName", "providerRef", "webUrl"] as const) {
    if (candidate[key] !== undefined && typeof candidate[key] !== "string") throw new Error(`backlog item: ${key} is invalid`);
  }
  const globalFields = ["workItemId", "issueNumber", "project", "managed", "executionEligible"] as const;
  if (globalFields.some(key => candidate[key] !== undefined)) {
    if (globalFields.some(key => candidate[key] === undefined)) throw new Error("backlog item: global identity fields must be provided together");
    const workItemId = parseWorkItemId(candidate.workItemId);
    const issueNumber = parseIssueNumber(candidate.issueNumber, "backlog item");
    const project = parseProviderProjectRef(candidate.project);
    assertWorkItemIdentityMatches(workItemId, issueNumber, project, "backlog item");
    if (typeof candidate.managed !== "boolean" || typeof candidate.executionEligible !== "boolean") throw new Error("backlog item: managed and executionEligible must be booleans");
    if (candidate.executionEligible && !candidate.managed) throw new Error("backlog item: unmanaged items cannot be execution eligible");
  }
  return candidate as unknown as BacklogItem;
}

function parseBacklogRunSummary(input: unknown): BacklogRunSummary {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("backlog runtime summary: activeRun is invalid");
  const candidate = input as Record<string, unknown>;
  assertExactKeys(candidate, ["id", "backlogId", "status", "startedAt", "template", "pid", "error"], "backlog run summary");
  if (typeof candidate.id !== "string" || typeof candidate.backlogId !== "string" || typeof candidate.startedAt !== "string") throw new Error("backlog run summary has invalid identity fields");
  if (!["starting", "running", "completed", "failed"].includes(candidate.status as string)) throw new Error("backlog run summary has invalid status");
  if (candidate.template !== undefined && typeof candidate.template !== "string") throw new Error("backlog run summary: template is invalid");
  if (candidate.pid !== undefined && typeof candidate.pid !== "number") throw new Error("backlog run summary: pid is invalid");
  if (candidate.error !== undefined && typeof candidate.error !== "string") throw new Error("backlog run summary: error is invalid");
  return candidate as unknown as BacklogRunSummary;
}

function parseBacklogRuntimeProjection(input: unknown): BacklogRuntimeProjection {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("backlog runtime summary: runtime is invalid");
  const candidate = input as Record<string, unknown>;
  assertExactKeys(candidate, ["runId", "status", "phase", "progress", "branch", "worktree", "diagnosticPath", "heartbeatAt"], "runtime projection");
  if (typeof candidate.runId !== "string" || typeof candidate.heartbeatAt !== "string") throw new Error("runtime projection has invalid identity fields");
  if (!["running", "stale", "completed", "blocked", "failed"].includes(candidate.status as string)) throw new Error("runtime projection has invalid status");
  if (candidate.phase !== "implementing" && candidate.phase !== "verifying") throw new Error("runtime projection has invalid phase");
  for (const key of ["progress", "branch", "worktree", "diagnosticPath"] as const) {
    if (candidate[key] !== undefined && typeof candidate[key] !== "string") throw new Error(`runtime projection: ${key} is invalid`);
  }
  return candidate as unknown as BacklogRuntimeProjection;
}

function isBacklogExecutionMode(value: unknown): value is BacklogExecutionMode {
  return typeof value === "string" && (BACKLOG_EXECUTION_MODES as readonly string[]).includes(value);
}

function assertExactKeys(candidate: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(candidate)) if (!allowedSet.has(key)) throw new Error(`${label} has unknown field: ${key}`);
}

export function parseBacklogPlatform(value: unknown): BacklogPlatform | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !BACKLOG_PLATFORMS.includes(value as BacklogPlatform)) {
    throw new Error(`backlog platform must be one of: ${BACKLOG_PLATFORMS.join(", ")}`);
  }
  return value as BacklogPlatform;
}

export function isBacklogState(value: unknown): value is BacklogState {
  return typeof value === "string" && (BACKLOG_STATES as readonly string[]).includes(value);
}

export function isBacklogPlatform(value: unknown): value is BacklogPlatform {
  return typeof value === "string" && (BACKLOG_PLATFORMS as readonly string[]).includes(value);
}

function parseRequiredBacklogPlatform(value: unknown, label: string): BacklogPlatform {
  if (!isBacklogPlatform(value)) throw new Error(`${label}: platform must be one of: ${BACKLOG_PLATFORMS.join(", ")}`);
  return value;
}

function parseProjectKey(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value || /[:#\s\x00-\x1f\x7f]/.test(value) || value.split("/").some(segment => segment === "." || segment === "..")) throw new Error(`${label}: projectKey is invalid`);
  return value;
}

function parseIssueNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label}: issueNumber must be a positive safe integer`);
  return value;
}

function parseRequiredString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function parseMultilineString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid`);
  return value;
}

function assertWorkItemIdentityMatches(id: WorkItemId, issueNumber: number, project: ProviderProjectRef, label: string): void {
  const expected = formatWorkItemId({ platform: project.platform, projectKey: project.projectKey, issueNumber });
  if (id !== expected) throw new Error(`${label}: global identity does not match project and issue number`);
}
