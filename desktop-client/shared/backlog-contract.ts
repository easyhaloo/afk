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

export type BacklogItem = {
  id: string;
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

export function parseBacklogId(input: unknown): string {
  if (typeof input !== "string") throw new Error("backlogId must be a string");
  const value = input.trim();
  if (!value || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("backlogId is invalid");
  return value;
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
  assertExactKeys(candidate, ["id", "title", "description", "parentId", "baseBacklogId", "dependsOn", "state", "executionMode", "tags", "branchName", "providerRef", "webUrl"], "backlog item");
  if (typeof candidate.id !== "string" || typeof candidate.title !== "string" || typeof candidate.branchName !== "string" || typeof candidate.providerRef !== "string" || !isBacklogState(candidate.state) || !isBacklogExecutionMode(candidate.executionMode)) throw new Error("backlog item has invalid identity or enum fields");
  if (!Array.isArray(candidate.dependsOn) || candidate.dependsOn.some(value => typeof value !== "string")) throw new Error("backlog item: dependsOn is invalid");
  if (!Array.isArray(candidate.tags) || candidate.tags.some(value => typeof value !== "string")) throw new Error("backlog item: tags is invalid");
  for (const key of ["description", "parentId", "baseBacklogId", "branchName", "providerRef", "webUrl"] as const) {
    if (candidate[key] !== undefined && typeof candidate[key] !== "string") throw new Error(`backlog item: ${key} is invalid`);
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
