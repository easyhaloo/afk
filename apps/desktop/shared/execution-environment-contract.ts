import { assertExactKeys, parseObject, parseRequiredString } from "./validation.js";
import { normalizeTmuxSessionName } from "./tmux-session.js";

/**
 * Shared Application execution read model (ADR-0019 §1).
 *
 * Identities are distinct and never interchangeable:
 *   - workItemId: canonical work item across attempts
 *   - runId:      one execution attempt
 *   - stepId:     a step inside the run's workflow snapshot
 *   - resourceId: registered execution environment resource
 *   - session:    provider-native identity, which need not be a tmux session
 */
export type ExecutionEnvironmentKind = "tmux" | "container" | "isolate-service";

export type ExecutionEnvironmentStatus = "active" | "closed" | "missing" | "failed";

/** Exact registered tmux control target. A session name alone is not one. */
export type TmuxAttachTarget = {
  session: string;
  windowId?: string;
  windowName?: string;
  paneId?: string;
};

export type ExecutionEnvironment = {
  resourceId: string;
  kind: ExecutionEnvironmentKind;
  status: ExecutionEnvironmentStatus;
  name: string;
  worktreePath: string;
  workspacePath: string;
  /** Attempt this resource is associated with; empty when unlinked. */
  runId?: string;
  /** Full registered tmux target; present only for kind === "tmux". */
  tmux?: TmuxAttachTarget;
  observedAt: string;
  detail?: string;
};

export type ExecutionEnvironmentUnavailable = {
  resourceId?: string;
  runId?: string;
  reason: string;
  observedAt?: string;
};

export type ExecutionEnvironmentQueryResult =
  | { available: true; environment: ExecutionEnvironment }
  | { available: false; unavailable: ExecutionEnvironmentUnavailable };

const TMUX_METADATA_KEYS = ["tmuxSession", "tmuxWindowId", "tmuxWindowName", "tmuxPaneId"] as const;

export function parseTmuxAttachTarget(input: unknown): TmuxAttachTarget {
  const candidate = parseObject(input, "tmux attach target");
  assertExactKeys(candidate, ["session", "windowId", "windowName", "paneId"], "tmux attach target");
  const target: TmuxAttachTarget = { session: parseRequiredString(candidate.session, "tmux attach target: session") };
  if (candidate.windowId !== undefined) {
    if (typeof candidate.windowId !== "string") throw new Error("tmux attach target: windowId must be a string");
    target.windowId = candidate.windowId;
  }
  if (candidate.windowName !== undefined) {
    if (typeof candidate.windowName !== "string") throw new Error("tmux attach target: windowName must be a string");
    target.windowName = candidate.windowName;
  }
  if (candidate.paneId !== undefined) {
    if (typeof candidate.paneId !== "string") throw new Error("tmux attach target: paneId must be a string");
    target.paneId = candidate.paneId;
  }
  return target;
}

/** `session:window.pane` form consumed by `tmux attach-session -t`. */
export function formatTmuxTarget(target: TmuxAttachTarget): string {
  const session = normalizeTmuxSessionName(target.session);
  if (target.windowId !== undefined) return `${session}:${target.windowId}.${target.paneId ?? "0"}`;
  if (target.windowName !== undefined) return `${session}:${target.windowName}${target.paneId ? `.${target.paneId}` : ""}`;
  return session;
}

/** Extract the registered tmux target from a resource metadata bag. */
export function tmuxTargetFromMetadata(metadata: Record<string, unknown>): TmuxAttachTarget | undefined {
  const session = metadata.tmuxSession;
  if (typeof session !== "string" || !session) return undefined;
  const target: TmuxAttachTarget = { session };
  if (typeof metadata.tmuxWindowId === "string") target.windowId = metadata.tmuxWindowId;
  if (typeof metadata.tmuxWindowName === "string") target.windowName = metadata.tmuxWindowName;
  if (typeof metadata.tmuxPaneId === "string") target.paneId = metadata.tmuxPaneId;
  return target;
}

export function parseExecutionEnvironment(input: unknown): ExecutionEnvironment {
  const candidate = parseObject(input, "execution environment");
  assertExactKeys(candidate, ["resourceId", "kind", "status", "name", "worktreePath", "workspacePath", "runId", "tmux", "observedAt", "detail"], "execution environment");
  if (candidate.kind !== "tmux" && candidate.kind !== "container" && candidate.kind !== "isolate-service") throw new Error("execution environment kind is invalid");
  if (candidate.status !== "active" && candidate.status !== "closed" && candidate.status !== "missing" && candidate.status !== "failed") throw new Error("execution environment status is invalid");
  if (typeof candidate.observedAt !== "string" || !candidate.observedAt) throw new Error("execution environment observedAt is invalid");
  const environment: ExecutionEnvironment = {
    resourceId: parseRequiredString(candidate.resourceId, "execution environment: resourceId"),
    kind: candidate.kind as ExecutionEnvironment["kind"],
    status: candidate.status as ExecutionEnvironment["status"],
    name: parseRequiredString(candidate.name, "execution environment: name"),
    worktreePath: parseRequiredString(candidate.worktreePath, "execution environment: worktreePath"),
    workspacePath: parseRequiredString(candidate.workspacePath, "execution environment: workspacePath"),
    observedAt: candidate.observedAt,
  };
  if (candidate.runId !== undefined) {
    if (typeof candidate.runId !== "string" || !candidate.runId) throw new Error("execution environment: runId must be a non-empty string");
    environment.runId = candidate.runId;
  }
  if (candidate.tmux !== undefined) {
    if (environment.kind !== "tmux") throw new Error("execution environment: tmux target is only valid on tmux resources");
    environment.tmux = parseTmuxAttachTarget(candidate.tmux);
  }
  if (candidate.detail !== undefined) {
    if (typeof candidate.detail !== "string") throw new Error("execution environment: detail must be a string");
    environment.detail = candidate.detail;
  }
  return environment;
}

/** Validate the metadata keys referenced by {@link tmuxTargetFromMetadata}. */
export function isTmuxMetadataKey(key: string): boolean {
  return (TMUX_METADATA_KEYS as readonly string[]).includes(key);
}
