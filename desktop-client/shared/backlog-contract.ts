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

export type BacklogRunSummary = {
  id: string;
  backlogId: string;
  status: "starting" | "running" | "completed" | "failed";
  startedAt: string;
  template?: string;
  pid?: number;
  error?: string;
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
  if (typeof candidate.backlogId !== "string" || !candidate.backlogId.trim()) throw new Error("backlog run input: backlogId is required");
  const result: BacklogRunStartInput = { backlogId: candidate.backlogId.trim() };
  if (candidate.template !== undefined) {
    if (typeof candidate.template !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(candidate.template)) throw new Error("backlog run input: template is invalid");
    result.template = candidate.template;
  }
  return result;
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
